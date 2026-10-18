// Verify Gate: when a turn changed code, run the project's own checks before
// the work counts as done. A failure goes straight back to Claude as the next
// prompt, up to a limit, so "done" means lint and tests are green.
import type { EngineInterface, Register } from 'claude-code'

type Options = { checkCommand?: string; runTests?: boolean; maxRetries?: number; timeoutSeconds?: number }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const CODE = /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|swift|cs|php|sql|sh)$/i

export type Check = { label: string; argv: string[] }

// The checks a project's own files say it runs, cheapest first.
export async function detectChecks(
  exists: (path: string) => Promise<boolean>,
  readText: (path: string) => Promise<string>,
  root: string,
  changed: string[],
  runTests: boolean,
): Promise<Check[]> {
  const checks: Check[] = []
  const py = changed.filter(f => /\.pyi?$/.test(f))
  const js = changed.filter(f => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(f))

  if (py.length && (await exists(`${root}/pyproject.toml`))) {
    const pyproject = await readText(`${root}/pyproject.toml`).catch(() => '')
    const runner = (await exists(`${root}/uv.lock`)) ? ['uv', 'run'] : ['python', '-m']
    if (/\bruff\b/.test(pyproject)) checks.push({ label: 'ruff', argv: [...runner, 'ruff', 'check', ...py] })
    if (runTests && /\bpytest\b/.test(pyproject)) checks.push({ label: 'pytest', argv: [...runner, 'pytest', '-q', '-x'] })
  }

  if (js.length && (await exists(`${root}/package.json`))) {
    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(await readText(`${root}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch {
      scripts = {}
    }
    const pm = (await exists(`${root}/pnpm-lock.yaml`)) ? 'pnpm' : (await exists(`${root}/bun.lockb`)) || (await exists(`${root}/bun.lock`)) ? 'bun' : 'npm'
    if (scripts.typecheck) checks.push({ label: 'typecheck', argv: [pm, 'run', 'typecheck'] })
    if (scripts.lint) checks.push({ label: 'lint', argv: [pm, 'run', 'lint'] })
    if (runTests && scripts.test && !/no test specified/.test(scripts.test)) checks.push({ label: 'test', argv: [pm, 'run', 'test'] })
  }
  return checks
}

// The tail of a long output, where test runners put the failures.
export function tail(text: string, max = 3500): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

type Ctx = { opts: Options; maxRetries: number; timeoutMs: number; runTests: boolean; retries: number }

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const ctx: Ctx = {
    opts,
    maxRetries: Math.max(0, Math.min(5, Number(opts.maxRetries ?? 2))),
    timeoutMs: Math.max(30, Math.min(600, Number(opts.timeoutSeconds ?? 300))) * 1000,
    runTests: opts.runTests !== false,
    retries: 0,
  }

  let changed = new Set<string>()
  let paused = false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'verify', description: 'Run the verify gate now, or /verify off|on for this session', argumentHint: '[off|on]' }).catch(() => {})
    return r
  })

  // A prompt from the person starts a fresh round of retries.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') ctx.retries = 0
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (EDIT_TOOLS.has(e.tool) && r.deny === undefined && !r.isError) {
      const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
      if (typeof path === 'string' && CODE.test(path)) changed.add(path)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.reason !== 'answer' || paused || changed.size === 0) return r
    const files = [...changed]
    changed = new Set()
    void gate($, files, ctx).catch(err => $.ui.log(`verify-gate: could not run checks: ${String(err)}`, { to: 'debug' }))
    return r
  })

  on('command.run', { command: 'verify' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      paused = arg === 'off'
      return { text: `verify-gate is ${paused ? 'paused' : 'on'} for this session.` }
    }
    const files = (await gitChanged($)).filter(f => CODE.test(f))
    if (!files.length) return { text: 'verify-gate: no changed code files to check.' }
    const result = await runChecks($, files, ctx)
    return { text: result.summary }
  })
}

async function gitChanged($: EngineInterface): Promise<string[]> {
  const r = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=all']).catch(() => null)
  if (!r || r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).replace(/^.* -> /, ''))
}

async function gate($: EngineInterface, files: string[], ctx: Ctx) {
  const result = await runChecks($, files, ctx)
  if (result.ok) {
    if (result.ran) $.ui.status(`verify ✓ ${result.ran}`)
    return
  }
  if (ctx.retries >= ctx.maxRetries) {
    $.ui.toast(`verify-gate: checks still failing after ${ctx.maxRetries} automatic retries; over to you.`)
    await $.ui.notify('Checks still failing after automatic retries.', { title: 'verify-gate' }).catch(() => {})
    return
  }
  ctx.retries += 1
  await $.prompt.submit({
    text: `verify-gate (automatic, retry ${ctx.retries}/${ctx.maxRetries}): the project's checks failed after your last change. Fix the cause (do not skip, disable or loosen tests or lint rules), then summarise what was wrong.\n\n${result.summary}`,
  })
}

async function runChecks($: EngineInterface, files: string[], ctx: Ctx): Promise<{ ok: boolean; ran: string; summary: string }> {
  const root = await $.session.root().catch(() => $.session.cwd())
  const rel = files.map(f => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f))
  let checks: Check[]
  if (ctx.opts.checkCommand?.trim()) checks = [{ label: 'check', argv: ['sh', '-c', ctx.opts.checkCommand.trim()] }]
  else checks = await detectChecks(p => $.fs.exists(p), p => $.fs.read(p), root, rel, ctx.runTests)
  if (!checks.length) return { ok: true, ran: '', summary: 'verify-gate: no checks found for this project (set checkCommand in the plugin options).' }

  $.ui.status(`verify: running ${checks.map(c => c.label).join(', ')}…`)
  const failed: string[] = []
  for (const c of checks) {
    const r = await $.process.run(c.argv, { cwd: root, timeoutMs: ctx.timeoutMs }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    if (r.exitCode !== 0) failed.push(`$ ${c.argv.join(' ')}  (exit ${r.exitCode})\n${tail(`${r.stdout}\n${r.stderr}`.trim())}`)
  }
  $.ui.status(undefined)
  const ran = checks.map(c => c.label).join(', ')
  if (!failed.length) return { ok: true, ran, summary: `verify-gate: ${ran} passed.` }
  return { ok: false, ran, summary: failed.join('\n\n') }
}
