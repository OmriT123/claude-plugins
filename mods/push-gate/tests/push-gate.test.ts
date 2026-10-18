import { describe, expect, mock, test } from 'claude-code/testing'

import { needsReview, sumNumstat, triggerOf } from '../hooks/register'

describe('what a call publishes', () => {
  test('git push, gh pr create/merge and the GitHub connector', () => {
    expect(triggerOf('Bash', { command: 'git push -u origin feature' })).toEqual({ kind: 'push' })
    expect(triggerOf('Bash', { command: 'cd app && git -C . push' })).toEqual({ kind: 'push' })
    expect(triggerOf('Bash', { command: 'git commit -m "then git push"' })).toBeNull()
    expect(triggerOf('Bash', { command: 'git push origin --delete old' })).toBeNull()
    expect(triggerOf('Bash', { command: 'gh pr create --fill' })).toEqual({ kind: 'pr' })
    expect(triggerOf('Bash', { command: 'gh pr merge 42 --squash' })).toEqual({ kind: 'merge', pr: '42' })
    expect(triggerOf('mcp__github__merge_pull_request', { pullNumber: 7 })).toEqual({ kind: 'merge', pr: '7' })
    expect(triggerOf('mcp__github__get_me', {})).toBeNull()
  })
})

describe('when a review is needed', () => {
  test('size or sensitive paths', () => {
    expect(needsReview(20, ['src/app.py'], 100)).toBeNull()
    expect(needsReview(150, ['src/app.py'], 100)).toMatch(/150 changed lines/)
    expect(needsReview(3, ['src/auth/session.py'], 100)).toMatch(/sensitive/)
    expect(needsReview(3, ['migrations/0007_add.sql'], 100)).toMatch(/sensitive/)
    expect(needsReview(3, ['src/ledger.py'], 100, /ledger/)).toMatch(/sensitive/)
  })

  test('numstat sums, binary files count as zero', () => {
    expect(sumNumstat('10\t2\ta.py\n-\t-\tlogo.png\n')).toEqual({ lines: 12, files: ['a.py', 'logo.png'] })
  })
})

// Stands for git and the engine beneath the mod.
function engine(on: any, git: Record<string, string>, ran: any[]) {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: '/r' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_$: any, e: any) => {
    const key = e.argv.slice(1).join(' ')
    const hit = Object.entries(git).find(([k]) => key.startsWith(k))
    return { value: hit ? { exitCode: 0, stdout: hit[1], stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') throw new Error('nobody to ask')
    ran.push(e)
    return { result: 'ok' }
  })
}

const GIT = {
  'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
  'merge-base HEAD origin/main': 'aaa',
  'diff --numstat aaa HEAD': '120\t30\tsrc/app.py',
  'rev-parse HEAD^{tree}': 'tree-head',
  'rev-parse --path-format=absolute --git-common-dir': '/r/.git',
  'rev-parse --absolute-git-dir': '/r/.git',
  'read-tree HEAD': '',
  'add -A': '',
  'write-tree': 'tree-head',
}

describe('in a session', () => {
  test('a large unreviewed push is held; after a Codex review of that content it goes through', async ($: any, on: any) => {
    const ran: any[] = []
    engine(on, GIT, ran)
    const held = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(held.deny).toMatch(/Codex has not reviewed/)
    await $.tool.call({ tool: 'mcp__plugin_claudex_codex__codex_review_diff', prompt: 'review' })
    const pushed = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(pushed.deny).toBeUndefined()
    expect(ran.map(r => r.tool)).toEqual(['mcp__plugin_claudex_codex__codex_review_diff', 'Bash'])
  })

  test('a Codex call that is not a review does not count as one', async ($: any, on: any) => {
    const ran: any[] = []
    engine(on, GIT, ran)
    await $.tool.call({ tool: 'Bash', command: 'codex exec "say hi"' })
    await $.tool.call({ tool: 'mcp__plugin_claudex_codex__codex_brainstorm', prompt: 'ideas' })
    expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toMatch(/Codex has not reviewed/)
  })

  test('a submitted review counts once its result is in', async ($: any, on: any) => {
    const ran: any[] = []
    engine(on, GIT, ran)
    await $.tool.call({ tool: 'mcp__plugin_claudex_codex__codex_submit', mode: 'review', prompt: 'review the diff' })
    expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeDefined()
    await $.tool.call({ tool: 'mcp__plugin_claudex_codex__codex_result', job: '1' })
    expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeUndefined()
  })

  test('a small push goes straight through', async ($: any, on: any) => {
    const ran: any[] = []
    engine(on, { ...GIT, 'diff --numstat aaa HEAD': '5\t1\tsrc/app.py' }, ran)
    const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(r.deny).toBeUndefined()
  })
})
