import { describe, expect, mock, test } from 'claude-code/testing'

import { amountFor, billedMinutes, formatAgorot, hoursText, toAgorot } from '../hooks/money'
import { billText, makeBill, type Entry } from '../hooks/register'

const H = 3_600_000
const M = 60_000

describe('money', () => {
  test('rates parse to whole agorot, nothing else parses', () => {
    expect(toAgorot('450')).toBe(45000)
    expect(toAgorot('450.5')).toBe(45050)
    expect(toAgorot('450.05')).toBe(45005)
    expect(toAgorot('7.085')).toBeNull()
    expect(toAgorot('-5')).toBeNull()
    expect(toAgorot('1e3')).toBeNull()
  })

  test('rounding to the increment', () => {
    expect(billedMinutes(128, 30, 'nearest')).toBe(120)
    expect(billedMinutes(128, 30, 'up')).toBe(150)
    expect(billedMinutes(135, 30, 'nearest')).toBe(150)
    expect(billedMinutes(128, 30, 'none')).toBe(128)
  })

  test('amounts are exact or say they were rounded', () => {
    expect(amountFor(45000, 120)).toEqual({ agorot: 90000, exact: true })
    expect(amountFor(45050, 15)).toEqual({ agorot: 11263, exact: false })
    expect(formatAgorot(123456)).toBe('1,234.56')
    expect(hoursText(120)).toBe('2')
    expect(hoursText(105)).toBe('1.75')
  })
})

describe('a bill', () => {
  const entries: Entry[] = [
    { id: '1', client: 'Acme', start: 0, end: 2 * H + 8 * M, note: 'session 2' },
    { id: '2', client: 'other', start: 0, end: H, note: '' },
    { id: '3', client: 'acme', start: 0, end: H, note: '', batch: 'old' },
  ]
  test('2:08 at 500/h, nearest half hour: 2 h, 1,000.00 excl. VAT', () => {
    const b = makeBill('acme', entries, { acme: '500' }, 30, 'nearest')
    expect(b.minutes).toBe(128)
    expect(b.billed).toBe(120)
    expect(b.amount).toBe(100000)
    const text = billText(b, 'NIS', 30, 'nearest', () => '2026-10-18')
    expect(text).toContain('worked 2:08, billed 2 h')
    expect(text).toContain('= 1,000.00 NIS excl. VAT.')
  })
  test('no rate: says how to set one', () => {
    expect(billText(makeBill('acme', entries, {}, 30, 'nearest'), 'NIS', 30, 'nearest', () => 'd')).toContain('/rate acme')
  })
})

describe('in a session', () => {
  test('clock, rate, preview, confirm: entries are marked billed and Claude is asked to record them', async ($: any, on: any) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-18T07:00:00Z') })
    mock.store(on)
    on('env.get', () => ({ value: undefined }))
    const prompts: string[] = []
    on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
    await $.command.run({ command: 'clock', args: 'start acme workshop' })
    await clock.advance(2 * H + 8 * M)
    expect((await $.command.run({ command: 'clock', args: 'stop' })).text).toContain('2:08')
    await $.command.run({ command: 'rate', args: 'acme 500' })
    const preview = await $.command.run({ command: 'bill', args: 'acme' })
    expect(preview.text).toContain('1,000.00 NIS excl. VAT')
    expect(preview.text).toContain('/bill acme confirm')
    const done = await $.command.run({ command: 'bill', args: 'acme confirm' })
    expect(done.text).toContain('Marked billed')
    await clock.advance(1)
    expect(prompts[0]).toContain('1,000.00')
    expect((await $.command.run({ command: 'bill', args: 'acme' })).text).toContain('Nothing unbilled')
  })
})
