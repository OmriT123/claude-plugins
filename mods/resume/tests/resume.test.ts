import { describe, expect, mock, test } from 'claude-code/testing'

import { ago, describePark } from '../hooks/register'

const P = { at: 0, cwd: '/r', branch: 'feature/x', head: 'abc123 Add parser', dirty: 2, note: 'finish tests', lastPrompt: 'fix the parser' }

describe('wording', () => {
  test('ago', () => {
    expect(ago(5 * 60_000)).toBe('5m ago')
    expect(ago(3 * 3_600_000)).toBe('3h ago')
    expect(ago(72 * 3_600_000)).toBe('3d ago')
  })
  test('a park reads as one short block', () => {
    expect(describePark(P, 3 * 3_600_000)).toBe(
      'Parked 3h ago on feature/x at abc123 Add parser, 2 uncommitted file(s).\nNote: finish tests\nLast ask: fix the parser',
    )
  })
})

function engine(on: any, prompts: string[]) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: '/r' }))
  on('process.run', (_$: any, e: any) => {
    const a = e.argv.slice(1).join(' ')
    const out = a.startsWith('branch') ? 'main' : a.startsWith('log') ? 'abc123 Init' : a.startsWith('rev-parse') ? '/r/.git' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  return clock
}

describe('in a session', () => {
  test('/park saves locally and asks Claude for the memory checkpoint; /where reads it back', async ($: any, on: any) => {
    const prompts: string[] = []
    const clock = engine(on, prompts)
    const parked = await $.command.run({ command: 'park', args: 'pick up the migration' })
    expect(parked.text).toContain('Parked locally')
    await clock.advance(1)
    expect(prompts[0]).toContain('shared-memory skill')
    expect(prompts[0]).toContain('pick up the migration')
    const where = await $.command.run({ command: 'where' })
    expect(where.text).toContain('Note: pick up the migration')
    expect(prompts.length).toBe(1)
  })

  test('/where with nothing parked asks Claude to read the checkpoint', async ($: any, on: any) => {
    const prompts: string[] = []
    const clock = engine(on, prompts)
    const where = await $.command.run({ command: 'where' })
    expect(where.text).toContain('No park saved')
    await clock.advance(1)
    expect(prompts[0]).toContain('latest Shared Memory checkpoint')
  })
})

describe('the reminder band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a parked repo opens with a reminder above the prompt (${surface})`, async ($: any, on: any) => {
      const prompts: string[] = []
      engine(on, prompts)
      on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
      on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'engine band' }))
      await $.command.run({ command: 'park', args: 'ship the parser' })
      await $.session.start({ surface, isInteractive: true, cwd: '/r' })
      const ui = await $.ui.mount({ plugin: 'resume', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } })
      const texts: any[] = (await ui.findAll({ type: 'Text' })) ?? []
      expect(texts.map(t => t.text).join('')).toContain('ship the parser')
    })
  }
})
