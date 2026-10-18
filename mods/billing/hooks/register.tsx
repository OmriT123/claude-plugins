// Billing: /clock times work per client, /bill turns unbilled time into an
// exact amount (whole agorot, stated rounding, excl. VAT) and, on confirm,
// has Claude record it in Shared Memory as revenue. Rates stay on this machine.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Running } from '../types'
import { amountFor, billedMinutes, formatAgorot, hm, hoursText, toAgorot, type Rounding } from './money'

type Options = { incrementMinutes?: number; rounding?: string; currency?: string }

export type Entry = { id: string; client: string; start: number; end: number; note: string; batch?: string }

const running = atom({ plugin: 'billing', key: 'running' } as const, null as Running | null)
const tick = atom({ plugin: 'billing', key: 'tick' } as const, 0)

const minutesOf = (e: { start: number; end: number }) => Math.max(0, Math.round((e.end - e.start) / 60_000))
const norm = (client: string) => client.trim().toLowerCase()

export type Bill = { client: string; entries: Entry[]; minutes: number; billed: number; rate: number | null; amount: number | null; exact: boolean }

export function makeBill(client: string, entries: Entry[], rates: Record<string, string>, increment: number, rounding: Rounding): Bill {
  const mine = entries.filter(e => norm(e.client) === norm(client) && !e.batch)
  const minutes = mine.reduce((s, e) => s + minutesOf(e), 0)
  const billed = billedMinutes(minutes, increment, rounding)
  const rateText = rates[norm(client)]
  const rate = rateText ? toAgorot(rateText) : null
  const amount = rate === null ? null : amountFor(rate, billed)
  return { client, entries: mine, minutes, billed, rate, amount: amount?.agorot ?? null, exact: amount?.exact ?? true }
}

export function billText(b: Bill, currency: string, increment: number, rounding: Rounding, date: (ms: number) => string): string {
  if (!b.entries.length) return `Nothing unbilled for ${b.client}.`
  const lines = b.entries.map(e => `- ${date(e.start)}  ${hm(minutesOf(e))}${e.note ? `  ${e.note}` : ''}`)
  const rule = rounding === 'none' ? 'no rounding' : `rounded ${rounding} to ${increment} min`
  return [
    `${b.client}: ${b.entries.length} session(s), worked ${hm(b.minutes)}, billed ${hoursText(b.billed)} h (${rule}).`,
    ...lines,
    b.rate === null || b.amount === null
      ? `No rate set: /rate ${b.client} <amount per hour>.`
      : `Amount: ${hoursText(b.billed)} h × ${formatAgorot(b.rate)} = ${formatAgorot(b.amount)} ${currency} excl. VAT${b.exact ? '' : ' (rounded to the agora)'}.`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const increment = Math.max(1, Number(opts.incrementMinutes ?? 30))
  const rounding: Rounding = opts.rounding === 'up' || opts.rounding === 'none' ? opts.rounding : 'nearest'
  const currency = opts.currency?.trim() || 'NIS'
  let timer: Timer | undefined // one redraw timer, even if session.start fires again

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    for (const c of [
      { name: 'clock', description: 'Time work per client: /clock start <client> [note], /clock stop, /clock list', argumentHint: 'start <client> [note] | stop | list' },
      { name: 'bill', description: 'Preview a client’s unbilled time and amount; add "confirm" to record it', argumentHint: '<client> [confirm]' },
      { name: 'rate', description: 'Set a client’s hourly rate (kept on this machine only)', argumentHint: '<client> <amount>' },
    ])
      await $.command.register(c).catch(() => {})
    const run = (await $.store.get('running')) as Running | undefined
    if (run) await update($, running, () => run)
    timer?.cancel()
    timer = $.clock.every(60_000, () => {
      void update($, tick, n => n + 1).catch(() => {})
    })
    return r
  })

  on('command.run', { command: 'clock' }, async ($, e) => {
    const [verb = '', clientWord = '', ...rest] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    const current = (await $.store.get('running')) as Running | undefined
    const remote = (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'
    const cloudNote = remote ? '\n(Cloud session: this clock lives as long as this container. /bill before you leave.)' : ''

    if (verb === 'start') {
      if (!clientWord) return { text: 'Usage: /clock start <client> [note]' }
      const stopped = current ? await stop($, current, now, '') : ''
      const run: Running = { client: clientWord, start: now, note: rest.join(' ') }
      await $.store.set('running', run)
      await update($, running, () => run)
      return { text: `${stopped}Clock running for ${clientWord}.${cloudNote}` }
    }
    if (verb === 'stop') {
      if (!current) return { text: 'No clock running.' }
      return { text: await stop($, current, now, [clientWord, ...rest].join(' ').trim()) }
    }
    if (verb === 'list' || verb === '') {
      const entries = await loadEntries($)
      const by = new Map<string, number>()
      for (const x of entries.filter(x => !x.batch)) by.set(x.client, (by.get(x.client) ?? 0) + minutesOf(x))
      const head = current ? `Running: ${current.client} for ${hm(minutesOf({ start: current.start, end: now }))}.` : 'No clock running.'
      const rows = [...by.entries()].map(([c, m]) => `- ${c}: ${hm(m)} unbilled`)
      return { text: [head, ...(rows.length ? ['Unbilled:', ...rows] : ['Nothing unbilled.'])].join('\n') + cloudNote }
    }
    return { text: 'Usage: /clock start <client> [note] | /clock stop [note] | /clock list' }
  })

  on('command.run', { command: 'rate' }, async ($, e) => {
    const [client = '', amount = ''] = e.args.trim().split(/\s+/)
    if (!client || toAgorot(amount) === null) return { text: 'Usage: /rate <client> <amount per hour>, e.g. /rate acme 500' }
    const rates = ((await $.store.get('rates')) as Record<string, string> | undefined) ?? {}
    await $.store.set('rates', { ...rates, [norm(client)]: amount })
    return { text: `Rate for ${client}: ${formatAgorot(toAgorot(amount) ?? 0)} ${currency}/h excl. VAT (stored on this machine only).` }
  })

  on('command.run', { command: 'bill' }, async ($, e) => {
    const [client = '', confirm = ''] = e.args.trim().split(/\s+/)
    if (!client) return { text: 'Usage: /bill <client> [confirm]' }
    const entries = await loadEntries($)
    const rates = ((await $.store.get('rates')) as Record<string, string> | undefined) ?? {}
    const bill = makeBill(client, entries, rates, increment, rounding)
    const text = billText(bill, currency, increment, rounding, jerusalemDate)
    if (confirm !== 'confirm' || !bill.entries.length) return { text: bill.entries.length ? `${text}\n\nRecord it with /bill ${client} confirm.` : text }
    if (bill.amount === null) return { text: `${text}\n\nSet a rate before confirming.` }

    const batch = `bill_${jerusalemDate(await $.clock.now())}_${norm(client).replace(/[^a-z0-9]+/g, '-')}_${bill.entries.length}`
    const ids = new Set(bill.entries.map(x => x.id))
    await $.store.set('entries', entries.map(x => (ids.has(x.id) ? { ...x, batch } : x)))
    submitSoon(
      $,
      [
        'Record this revenue report in Shared Memory using the shared-memory skill (read first, revision guard, stable operation ID = the batch id below). Use the figures exactly as given; do not recompute them.',
        `Batch: ${batch}`,
        text,
        'Confirm the receipt in one line.',
      ].join('\n'),
    )
    return { text: `${text}\n\nMarked billed as ${batch}. Asking Claude to record it in Shared Memory…` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const run = await read($, running)
    await read($, tick)
    if (!run || e.props.hasSurvey) return rest
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const mine = (
      <Box key="billing" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color="green">{`⏱ ${run.client} ${hm(minutesOf({ start: run.start, end: now }))}`}</Text>
          <Text dimColor>{run.note ? ` · ${run.note}` : ''}</Text>
        </Text>
      </Box>
    )
    return rest ? <Box flexDirection="column">{[mine, rest]}</Box> : mine
  })
}

async function stop($: EngineInterface, run: Running, now: number, note: string): Promise<string> {
  const entries = await loadEntries($)
  const entry: Entry = { id: `${run.start}`, client: run.client, start: run.start, end: now, note: [run.note, note].filter(Boolean).join(' — ') }
  await $.store.set('entries', [...entries, entry])
  await $.store.delete('running')
  await update($, running, () => null)
  return `Stopped ${run.client}: ${hm(minutesOf(entry))}. `
}

async function loadEntries($: EngineInterface): Promise<Entry[]> {
  return ((await $.store.get('entries')) as Entry[] | undefined) ?? []
}

function submitSoon($: EngineInterface, text: string): void {
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch(() => {})
  })
}

// The calendar date in Israel, ISO style.
export function jerusalemDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}
