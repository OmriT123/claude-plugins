// Push Gate: a push (or PR) whose change is large or touches sensitive code
// needs a Codex review of that exact content first; a merge needs green CI.
// Also shows each running Codex review on the status line and says when it
// ends.
import type { EngineInterface, Register } from 'claude-code'

import { base, commands, leadingCd, resolvePath, subcommand } from './shell'

type Options = { minLines?: number; sensitivePaths?: string; followUpLines?: number }

const SENSITIVE = /(?:^|\/)(?:auth|oauth|security|permissions?|crypto|secrets?|migrations?|alembic|schema|policies|billing|payments?)(?:\/|\.|_|-|$)|\.sql$/i
// Only reviews count: codex_review/codex_review_diff, or a codex_result for a
// job that was submitted as a review. Any other Codex call is shown, not counted.
const CODEX_TOOL = /codex.*__codex_(?:review|review_diff|critique|collab|evaluate|submit|result)$/i
const REVIEW_TOOL = /__codex_review(?:_diff)?$/i
const REVIEWS_KEPT = 20

type Reviewed = { tree: string; at: number }

export type Trigger = { kind: 'push' | 'pr' | 'merge'; dir?: string; pr?: string }

// The folder a `git -C <dir> push` names, if any.
function pushDir(src: string): string | undefined {
  for (const c of commands(src)) {
    if (base(c.words[0]) !== 'git' || subcommand(c)[0] !== 'push') continue
    const i = c.words.indexOf('-C')
    if (i > 0) return c.words[i + 1]
  }
  return undefined
}

// What a Bash command or connector call would publish, if anything.
export function triggerOf(tool: string, input: Record<string, unknown>): Trigger | null {
  if (tool === 'mcp__github__push_files') return { kind: 'push' }
  if (tool === 'mcp__github__create_pull_request') return { kind: 'pr' }
  if (tool === 'mcp__github__merge_pull_request') return { kind: 'merge', pr: String(input.pullNumber ?? input.pull_number ?? '') }
  if (tool !== 'Bash') return null
  const src = String(input.command ?? '')
  for (const c of commands(src)) {
    const name = base(c.words[0])
    const sub = name === 'git' || name === 'gh' ? subcommand(c) : []
    if (name === 'git' && sub[0] === 'push' && !sub.includes('--delete') && !sub.includes('-d')) return { kind: 'push' }
    if (name === 'gh' && sub[0] === 'pr' && sub[1] === 'create') return { kind: 'pr' }
    if (name === 'gh' && sub[0] === 'pr' && sub[1] === 'merge') return { kind: 'merge', pr: sub.slice(2).find(a => /^\d+$/.test(a)) }
  }
  return null
}

// Whether a change of this size and these files needs a review.
export function needsReview(lines: number, files: string[], minLines: number, extra?: RegExp): string | null {
  const touchy = files.filter(f => SENSITIVE.test(f) || (extra?.test(f) ?? false))
  if (touchy.length) return `touches sensitive code (${touchy.slice(0, 3).join(', ')}${touchy.length > 3 ? '…' : ''})`
  if (lines >= minLines) return `${lines} changed lines (threshold ${minLines})`
  return null
}

export function sumNumstat(numstat: string): { lines: number; files: string[] } {
  let lines = 0
  const files: string[] = []
  for (const row of numstat.split('\n')) {
    const [a, d, path] = row.split('\t')
    if (!path) continue
    files.push(path)
    lines += (Number(a) || 0) + (Number(d) || 0)
  }
  return { lines, files }
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const minLines = Math.max(1, Number(opts.minLines ?? 100))
  const followUp = Math.max(0, Number(opts.followUpLines ?? 40))
  let extra: RegExp | undefined
  try {
    extra = opts.sensitivePaths?.trim() ? new RegExp(opts.sensitivePaths.split(',').map(s => s.trim()).filter(Boolean).join('|'), 'i') : undefined
  } catch {
    extra = undefined
  }
  const running = new Map<string, { label: string; since: number }>()
  let reviewSubmitted = false // a codex_submit asked for a review; its codex_result counts

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>

    // A Codex review: show it while it runs, and remember what it saw.
    if (CODEX_TOOL.test(e.tool) || (e.tool === 'Bash' && runsCodexReview(String(input.command ?? '')))) {
      const label = e.tool === 'Bash' ? 'codex (CLI)' : e.tool.split('__').pop() ?? 'codex'
      const since = await $.clock.now()
      const isSubmit = /__codex_submit$/i.test(e.tool)
      const counts = REVIEW_TOOL.test(e.tool) || e.tool === 'Bash' || (/__codex_result$/i.test(e.tool) && reviewSubmitted)
      if (isSubmit) reviewSubmitted = /review/i.test(JSON.stringify(input))
      // The content under review is what's on disk as the review starts.
      const dir = counts ? await reviewDir($, input) : ''
      const tree = counts ? await workingTree($, dir) : null
      running.set(e.tool_use_id ?? `${since}`, { label, since })
      $.ui.status(statusLine(running, since))
      const r = await next(e)
      running.delete(e.tool_use_id ?? `${since}`)
      const now = await $.clock.now()
      $.ui.status(running.size ? statusLine(running, now) : undefined)
      if (r.deny === undefined && !r.isError) {
        const secs = Math.round((now - since) / 1000)
        $.ui.toast(`Codex ${label} finished (${secs}s)`)
        if (secs >= 60) await $.ui.notify(`Codex ${label} finished after ${secs}s`, { title: 'push-gate' }).catch(() => {})
        if (counts && tree) {
          await remember($, dir, tree)
          if (/__codex_result$/i.test(e.tool)) reviewSubmitted = false
        }
      }
      return r
    }

    const t = triggerOf(e.tool, input)
    if (!t) return next(e)
    const here = e.tool === 'Bash' ? await runDir($, String(input.command ?? '')) : await $.session.cwd()
    const gitC = e.tool === 'Bash' ? pushDir(String(input.command ?? '')) : undefined
    const dir = gitC ? (resolvePath(here, gitC, (await $.env.get('HOME')) ?? '') ?? here) : here

    if (t.kind === 'merge') {
      const ci = await ciState($, dir, t.pr)
      if (ci && (ci.fail.length || ci.pending)) {
        const what = ci.fail.length ? `CI failing (${ci.fail.slice(0, 3).join(', ')})` : `${ci.pending} CI check(s) still running`
        const ok = await ask($, `push-gate: ${what}. Merge anyway?`, ['Hold', 'Merge anyway'])
        if (ok !== 'Merge anyway') return { deny: `push-gate: held the merge: ${what}. Fix CI (or wait for it) first.` }
      }
      return next(e)
    }

    const change = await outgoing($, dir)
    if (!change) return next(e) // not a repo, or nothing ahead of the base: nothing to judge
    const why = needsReview(change.lines, change.files, minLines, extra)
    if (!why) return next(e)
    if (await reviewedEnough($, dir, change.tree, followUp, extra)) return next(e)

    const ok = await ask($, `push-gate: this ${t.kind === 'pr' ? 'PR' : 'push'} ${why}, and Codex hasn't reviewed this content. Push without a review?`, [
      'Hold for review',
      'Push anyway',
    ])
    if (ok === 'Push anyway') return next(e)
    return {
      deny: `push-gate: held: this change ${why} and Codex has not reviewed it. Run a Codex review of the diff (Claudex review-diff), address its findings, then push again. Follow-up fixes under ${followUp} lines that touch nothing sensitive don't need another review.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : triggerOf(e.tool, e as unknown as Record<string, unknown>) ? { deny: 'push-gate: its check failed, so the push is held. Retry, or ask the user.' } : next(e)))
}

// `codex review`, directly or through a package runner; `codex exec` is not a review.
function runsCodexReview(src: string): boolean {
  return commands(src).some(c => {
    const i = c.words.findIndex(w => /(^|[/@])codex(\.[cm]?js)?($|[@/])/i.test(w))
    return i >= 0 && i <= 2 && c.words.slice(i + 1).find(w => !w.startsWith('-')) === 'review'
  })
}

function statusLine(running: Map<string, { label: string; since: number }>, now: number): string {
  return [...running.values()].map(r => `⟳ Codex ${r.label} ${Math.round((now - r.since) / 1000)}s`).join(' · ')
}

async function ask($: EngineInterface, question: string, options: string[]): Promise<string> {
  try {
    return await $.ui.ask(question, { options, header: 'Push gate' })
  } catch {
    return ''
  }
}

async function git($: EngineInterface, dir: string, args: string[], env?: Record<string, string>): Promise<string | null> {
  const r = await $.process.run(['git', ...args], { cwd: dir, timeoutMs: 30_000, ...(env ? { env } : {}) }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() : null
}

async function runDir($: EngineInterface, command: string): Promise<string> {
  let dir = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  for (const t of leadingCd(command)) {
    const r = resolvePath(dir, t, home)
    if (r === null) break
    dir = r
  }
  return dir
}

async function reviewDir($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  for (const k of ['project_dir', 'projectDir', 'cwd', 'workspace']) {
    const v = input[k]
    if (typeof v === 'string' && v.startsWith('/')) return v
  }
  return typeof input.command === 'string' ? runDir($, input.command) : $.session.cwd()
}

// What the branch would publish: everything ahead of the default branch, as
// a tree. Measured against the default branch, not the upstream, so a change
// pushed in small pieces still adds up.
async function outgoing($: EngineInterface, dir: string): Promise<{ lines: number; files: string[]; tree: string } | null> {
  const baseRef = (await git($, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'origin/main'
  const mb = await git($, dir, ['merge-base', 'HEAD', baseRef])
  if (!mb) return null
  const numstat = await git($, dir, ['diff', '--numstat', mb, 'HEAD'])
  const tree = await git($, dir, ['rev-parse', 'HEAD^{tree}'])
  if (numstat === null || !tree || !numstat) return null
  return { ...sumNumstat(numstat), tree }
}

// The working tree as a git tree hash, without touching the real index.
async function workingTree($: EngineInterface, dir: string): Promise<string | null> {
  const gitDir = await git($, dir, ['rev-parse', '--absolute-git-dir'])
  if (!gitDir) return null
  const env = { GIT_INDEX_FILE: `${gitDir}/push-gate.index` }
  if ((await git($, dir, ['read-tree', 'HEAD'], env)) === null) return null
  if ((await git($, dir, ['add', '-A'], env)) === null) return null
  return git($, dir, ['write-tree'], env)
}

async function repoKey($: EngineInterface, dir: string): Promise<string | null> {
  const common = await git($, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common ? `reviewed:${common}` : null
}

async function remember($: EngineInterface, dir: string, tree: string): Promise<void> {
  const key = await repoKey($, dir)
  if (!key) return
  const list = ((await $.store.get(key)) as Reviewed[] | undefined) ?? []
  await $.store.set(key, [...list.filter(r => r.tree !== tree), { tree, at: await $.clock.now() }].slice(-REVIEWS_KEPT))
}

// Reviewed when Codex saw this exact tree, or one a small, non-sensitive
// follow-up away (the fixes for its own findings).
async function reviewedEnough($: EngineInterface, dir: string, tree: string, followUp: number, extra?: RegExp): Promise<boolean> {
  const key = await repoKey($, dir)
  if (!key) return false
  const list = ((await $.store.get(key)) as Reviewed[] | undefined) ?? []
  if (list.some(r => r.tree === tree)) return true
  for (const r of [...list].reverse().slice(0, 5)) {
    const numstat = await git($, dir, ['diff', '--numstat', r.tree, tree])
    if (numstat === null) continue
    const d = sumNumstat(numstat)
    if (d.lines <= followUp && !needsReview(0, d.files, Number.MAX_SAFE_INTEGER, extra)) return true
  }
  return false
}

// CI for a PR via the gh CLI; null when gh can't tell (not installed, no PR).
async function ciState($: EngineInterface, dir: string, pr?: string): Promise<{ fail: string[]; pending: number } | null> {
  const r = await $.process
    .run(['gh', 'pr', 'checks', ...(pr ? [pr] : []), '--json', 'name,bucket'], { cwd: dir, timeoutMs: 20_000 })
    .catch(() => null)
  if (!r || !r.stdout.trim().startsWith('[')) return null
  try {
    const rows = JSON.parse(r.stdout) as { name: string; bucket: string }[]
    return { fail: rows.filter(x => x.bucket === 'fail' || x.bucket === 'cancel').map(x => x.name), pending: rows.filter(x => x.bucket === 'pending').length }
  } catch {
    return null
  }
}
