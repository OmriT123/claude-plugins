import { describe, expect, mock, test } from 'claude-code/testing'

import { detectChecks, tail } from '../hooks/register'

const files = (map: Record<string, string>) => ({
  exists: async (p: string) => p in map,
  read: async (p: string) => map[p] ?? '',
})

describe('detectChecks', () => {
  test('a uv project with ruff and pytest gets both, ruff on the changed files only', async () => {
    const f = files({ '/r/pyproject.toml': '[dependency-groups]\ndev = ["ruff", "pytest"]', '/r/uv.lock': '' })
    const checks = await detectChecks(f.exists, f.read, '/r', ['src/a.py', 'README.md'], true)
    expect(checks).toEqual([
      { label: 'ruff', argv: ['uv', 'run', 'ruff', 'check', 'src/a.py'] },
      { label: 'pytest', argv: ['uv', 'run', 'pytest', '-q', '-x'] },
    ])
  })

  test('package.json scripts, skipping the npm placeholder test', async () => {
    const f = files({ '/r/package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1' } }) })
    expect(await detectChecks(f.exists, f.read, '/r', ['src/x.ts'], true)).toEqual([{ label: 'lint', argv: ['npm', 'run', 'lint'] }])
  })

  test('no code changed in a language means no checks for it', async () => {
    const f = files({ '/r/pyproject.toml': 'ruff pytest' })
    expect(await detectChecks(f.exists, f.read, '/r', ['web/app.ts'], true)).toEqual([])
  })

  test('tail keeps the end', () => {
    expect(tail('abcdef', 3)).toBe('…def')
  })
})

describe('in a session', () => {
  test('a failing check after an edit goes back to Claude as the next prompt', async ($: any, on: any) => {
    mock.clock(on, { now: 0 })
    const prompts: string[] = []
    on('session.root', () => ({ value: '/r' }))
    on('session.cwd', () => ({ value: '/r' }))
    on('fs.exists', (_$: any, e: any) => ({ value: ['/r/pyproject.toml', '/r/uv.lock'].includes(e.path) }))
    on('fs.read', () => ({ value: 'ruff' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: 'src/a.py:1:1: F401 unused import', stderr: '' } }))
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.status', () => ({ value: undefined }))
    on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
    on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
    await $.tool.call({ tool: 'Edit', file_path: '/r/src/a.py', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    for (let i = 0; i < 200 && prompts.length === 0; i++) await Promise.resolve()
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('F401')
  })
})
