// Resume: /park saves where you left off (locally at once, and as a Shared
// Memory checkpoint through Claude), /where tells you where you were, the
// next session in the repo opens with a reminder, and a long turn that ends
// while you're away sends a notification.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Parked } from '../types'

type Options = { notifyAfterSeconds?: number }

const banner = atom({ plugin: 'resume', key: 'banner' } as const, null as Parked | null)

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function describePark(p: Parked, now: number): string {
  return [
    `Parked ${ago(now - p.at)} on ${p.branch || '(no branch)'} at ${p.head || '(no commits)'}${p.dirty ? `, ${p.dirty} uncommitted file(s)` : ''}.`,
    p.note ? `Note: ${p.note}` : '',
    p.lastPrompt ? `Last ask: ${p.lastPrompt}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const CHECKPOINT = (note: string) =>
  [
    'Save a Shared Memory checkpoint for the project in this repository, using the shared-memory skill (read the project record first, then update with the revision guard and a stable operation ID).',
    'Keep it short and source-linked: what was done this session, what is in progress, what is blocked or waiting on me, and the single next step.',
    note ? `My note: ${note}` : '',
    'Confirm the receipt in one line when done.',
  ]
    .filter(Boolean)
    .join('\n')

const RECALL =
  'Read the latest Shared Memory checkpoint for the project in this repository, plus `git log -5 --oneline` and `git status --short`, and tell me in at most 5 lines: the goal, what is done, what is in progress, what waits on me, and the next step.'

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const notifyAfter = Math.max(10, Number(opts.notifyAfterSeconds ?? 90)) * 1000
  let lastPrompt = ''

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    for (const c of [
      { name: 'park', description: 'Save where you left off here and as a Shared Memory checkpoint', argumentHint: '[note]' },
      { name: 'where', description: 'Where was I? Your last park here, or the latest checkpoint' },
      { name: 'checkpoint', description: 'Ask Claude to save a Shared Memory checkpoint now', argumentHint: '[note]' },
    ])
      await $.command.register(c).catch(() => {})
    const p = await loadPark($)
    if (p) {
      const now = await $.clock.now()
      await update($, banner, () => p)
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `resume: ${describePark(p, now)} (/where for more)` }] } }).catch(() => {})
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin' && !e.text.startsWith('/')) {
      lastPrompt = e.text.replace(/\s+/g, ' ').slice(0, 200)
      await update($, banner, () => null) // the reminder has done its job once you're working
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && !e.isAborted && e.durationMs >= notifyAfter) {
      const first = e.answer.split('\n').find(l => l.trim()) ?? 'Claude finished.'
      await $.ui.notify(first.length > 140 ? `${first.slice(0, 140)}…` : first, { title: `Done after ${Math.round(e.durationMs / 60_000)} min` }).catch(() => {})
    }
    return r
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const p = await snapshot($, e.args.trim(), lastPrompt)
    await $.store.set(await parkKey($), p)
    submitSoon($, CHECKPOINT(p.note))
    return { text: `Parked locally: ${describePark(p, p.at)}\nAsking Claude to save the Shared Memory checkpoint…` }
  })

  on('command.run', { command: 'checkpoint' }, async ($, e) => {
    submitSoon($, CHECKPOINT(e.args.trim()))
    return { text: 'Asking Claude to save a Shared Memory checkpoint…' }
  })

  on('command.run', { command: 'where' }, async ($) => {
    const p = await loadPark($)
    if (p) {
      const now = await $.clock.now()
      const live = await snapshot($, '', '')
      const moved = live.head !== p.head ? `\nSince then: HEAD is ${live.head}${live.dirty ? `, ${live.dirty} uncommitted file(s)` : ''}.` : ''
      return { text: `${describePark(p, now)}${moved}` }
    }
    submitSoon($, RECALL)
    return { text: 'No park saved on this machine for this repo; asking Claude to read the latest checkpoint…' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const p = await read($, banner)
    if (!p || e.props.hasSurvey) return rest
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const mine = (
      <Box key="resume" paddingX={1}>
        <Text wrap="truncate-end">
          <Text dimColor>{`↩ parked ${ago(now - p.at)} · `}</Text>
          <Text>{p.note || p.lastPrompt || p.branch}</Text>
          <Text dimColor>{' · /where'}</Text>
        </Text>
      </Box>
    )
    return rest ? <Box flexDirection="column">{[mine, rest]}</Box> : mine
  })
}

// A command's hook can't start a turn while it holds this one: submit just after.
function submitSoon($: EngineInterface, text: string): void {
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch(() => {})
  })
}

async function git($: EngineInterface, args: string[]): Promise<string> {
  const r = await $.process.run(['git', ...args], { timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() : ''
}

async function snapshot($: EngineInterface, note: string, lastPrompt: string): Promise<Parked> {
  const status = await git($, ['status', '--porcelain'])
  return {
    at: await $.clock.now(),
    cwd: await $.session.cwd(),
    branch: await git($, ['branch', '--show-current']),
    head: await git($, ['log', '-1', '--format=%h %s']),
    dirty: status ? status.split('\n').length : 0,
    note,
    lastPrompt,
  }
}

async function parkKey($: EngineInterface): Promise<string> {
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return `park:${common || (await $.session.cwd())}`
}

async function loadPark($: EngineInterface): Promise<Parked | null> {
  const v = (await $.store.get(await parkKey($))) as Parked | undefined
  return v && typeof v.at === 'number' ? v : null
}
