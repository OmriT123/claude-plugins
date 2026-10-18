// Guardrail: keeps secrets out of what Claude reads, keeps confidential and
// personal data away from Codex, holds actions that reach people, money or
// can't be undone until the person says yes, and refuses to commit secrets.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { connectorHold, gitWrites, isCodexTool, runsCodex, sendsOut, shellHolds } from './rules'
import { PLACEHOLDER, Vault, compileExtra, findPii, findSecrets, findTerms, mapStrings, neverCommit, split } from './secrets'
import { leadingCd, resolvePath } from './shell'

type Options = {
  confidentialTerms?: string
  extraSecretPatterns?: string
  extraNeverCommit?: string
  holdTools?: string
  allowTools?: string
  scanPii?: boolean
  redactTranscript?: boolean
}

const vault = atom({ plugin: 'guardrail', key: 'vault' } as const, {} as Record<string, string>)

// Tools that run on this machine: the only ones that get real values back.
const LOCAL_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
const GRANT_MS = 15 * 60_000

const regex = (src: string | undefined) => {
  const parts = split(src)
  if (!parts.length) return undefined
  try {
    return new RegExp(parts.join('|'), 'i')
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const terms = split(opts.confidentialTerms)
  const extraSecrets = compileExtra(opts.extraSecretPatterns).patterns
  const extraNever = compileExtra(opts.extraNeverCommit).patterns
  const holdExtra = regex(opts.holdTools)
  const allowExtra = regex(opts.allowTools)
  const scanPii = opts.scanPii !== false
  const redactOn = opts.redactTranscript !== false

  // Session-only: one-shot grants by fingerprint, tool windows, codes.
  const onceGrants = new Map<string, number>()
  const toolGrants = new Map<string, number>()
  const codes = new Map<string, { fp: string; tool: string; until: number }>()
  const projectOk = new Set<string>()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command
      .register({ name: 'allow', description: 'Allow one action the guardrail held (by its code)', argumentHint: '<code>' })
      .catch(() => {})
    await $.command.register({ name: 'guardrail', description: 'Show what the guardrail is protecting this session' }).catch(() => {})
    return r
  })

  // Secrets never reach the model: every row it reads is redacted first.
  on('session.append', async ($, e, next) => {
    if (!redactOn || e.message.role === 'assistant' || !e.message.content) return next(e)
    const v = new Vault({ ...(await read($, vault)) })
    let changed = false
    const content = e.message.content.map(block => {
      const b = block as { type: string; text?: string; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        const r = v.redact(b.text, extraSecrets)
        changed ||= r.changed
        return r.changed ? { ...b, text: r.text } : block
      }
      if (b.type === 'tool_result' && b.content !== undefined) {
        const mapped = mapStrings(b.content, s => {
          const r = v.redact(s, extraSecrets)
          changed ||= r.changed
          return r.text
        })
        return changed ? { ...b, content: mapped } : block
      }
      return block
    })
    if (!changed) return next(e)
    await update($, vault, old => ({ ...old, ...v.entries }))
    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
  }).catch(($, e, next) => {
    // A row can't be refused. If redaction failed, it lands withheld, not raw.
    if (next.called || !redactOn || e.message.role === 'assistant' || !e.message.content) return next(e)
    const withheld = '[guardrail: content withheld because secret redaction failed]'
    const content = e.message.content.map(block => {
      const b = block as { type: string }
      if (b.type === 'text') return { ...b, text: withheld }
      if (b.type === 'tool_result') return { ...b, content: withheld }
      return block
    })
    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
  })

  on('tool.call', async ($, e, next) => {
    const args: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) args[k] = v
    const command = e.tool === 'Bash' ? String((args as { command?: unknown }).command ?? '') : ''
    const toCodex = isCodexTool(e.tool) || (e.tool === 'Bash' && runsCodex(command))

    // 1. Codex: nothing confidential leaves for a third party without a yes.
    if (toCodex) {
      const payload = e.tool === 'Bash' ? command : JSON.stringify(args)
      const found = [
        ...findSecrets(payload, extraSecrets).map(s => `a secret (${s.slice(0, 4)}…)`),
        ...findTerms(payload, terms).map(t => `confidential term "${t}"`),
        ...(scanPii ? findPii(payload).map(p => `personal data (${p})`) : []),
      ]
      const dir = await codexDir($, args, command)
      const exposed = dir && !projectOk.has(dir) ? await sensitiveFiles($, dir, extraNever) : []
      if (found.length) {
        const ok = await ask(
          $,
          `Guardrail: this Codex call would send ${found.slice(0, 6).join(', ')}${found.length > 6 ? ` and ${found.length - 6} more` : ''} to OpenAI. Send it anyway?`,
          ['Block', 'Send anyway'],
        )
        if (ok !== 'Send anyway')
          return { deny: `guardrail: blocked a Codex call carrying ${found.length} confidential item(s). Remove them (describe the problem without the data), then retry.` }
      }
      if (exposed.length && dir) {
        const ok = await ask(
          $,
          `Guardrail: Codex can read files in ${dir}, including ${exposed.slice(0, 5).join(', ')}${exposed.length > 5 ? ` (+${exposed.length - 5})` : ''}. Let Codex work in this folder?`,
          ['Block', 'Allow this folder'],
        )
        if (ok !== 'Allow this folder')
          return { deny: `guardrail: Codex would be able to read secret files in ${dir} (${exposed.slice(0, 3).join(', ')}). Point it at a folder without them.` }
        projectOk.add(dir)
      }
      // Fall through: the rest of a chained command is still checked below.
    }

    // 2. Never commit secrets, local databases or OAuth state.
    if (e.tool === 'Bash') {
      const g = gitWrites(command)
      const bad = g.adds.filter(p => neverCommit(p, extraNever))
      if (g.commits) bad.push(...(await staged($, command, g.dir, g.commitAll || g.addAll, g.addAll)).filter(p => neverCommit(p, extraNever)))
      if (bad.length) return { deny: `guardrail: refusing to stage or commit ${[...new Set(bad)].join(', ')}: secrets, databases and OAuth state never go into git. Unstage them (git restore --staged <path>) and add them to .gitignore.` }
    }
    if (/^mcp__github__(?:push_files|create_or_update_file)$/.test(e.tool)) {
      const a = args as { path?: string; files?: { path?: string }[] }
      const paths = [a.path, ...(a.files ?? []).map(f => f.path)].filter((p): p is string => typeof p === 'string')
      const bad = paths.filter(p => neverCommit(p, extraNever))
      if (bad.length) return { deny: `guardrail: refusing to push ${bad.join(', ')} to GitHub.` }
    }

    // 3. Hold what reaches people, money, or can't be undone.
    const why = e.tool === 'Bash' ? shellHolds(command) : [connectorHold(e.tool, holdExtra, allowExtra)].filter((x): x is string => !!x)
    if (why.length) {
      const now = await $.clock.now()
      const fp = await fingerprint(e.tool, args)
      const once = onceGrants.get(fp)
      const scope = `${e.tool}\n${why.join('; ')}`
      const windowed = (toolGrants.get(scope) ?? 0) > now
      if (once && once > now) onceGrants.delete(fp)
      else if (!windowed) {
        const answer = await ask($, `Guardrail: ${why.join('; ')}.\n\n${preview(e.tool, args)}\n\nGo ahead?`, ['Block', 'Allow once', 'Allow this kind for 15 min'])
        if (answer === 'Allow this kind for 15 min') toolGrants.set(scope, now + GRANT_MS)
        else if (answer !== 'Allow once') {
          const code = newCode()
          codes.set(code, { fp, tool: e.tool, until: now + GRANT_MS })
          return {
            deny: `guardrail: held (${why.join('; ')}). Show the user exactly what this would do and ask. If they want it, they run /allow ${code}, then retry the identical call.`,
          }
        }
      }
    }

    // 4. Local tools get the real values behind placeholders; never Codex,
    //    and a command that can send data out only with the person's yes.
    const used = JSON.stringify(args).match(PLACEHOLDER)
    if (LOCAL_TOOLS.has(e.tool) && used && !toCodex) {
      if (e.tool === 'Bash' && sendsOut(command)) {
        const ok = await ask($, `Guardrail: this command can send data off this machine and would carry the real value of ${[...new Set(used)].join(', ')}.\n\n${preview(e.tool, args)}\n\nPut the real secret in?`, [
          'Keep the placeholder',
          'Use the real secret',
        ])
        if (ok !== 'Use the real secret') return next(e)
      }
      const v = new Vault(await read($, vault))
      return next({ ...e, ...mapStrings(args, s => v.restore(s)) } as typeof e)
    }
    return next(e)
  }).catch(($, e, next) => {
    // Fail closed for anything this guard would hold; let the rest through.
    const risky = e.tool === 'Bash' ? shellHolds(String((e as { command?: unknown }).command ?? '')).length > 0 || runsCodex(String((e as { command?: unknown }).command ?? '')) : isCodexTool(e.tool) || connectorHold(e.tool, holdExtra, allowExtra) !== null
    if (next.called) return next(e)
    if (next.error?.kind === 're-entry' && !risky) return next(e)
    return risky ? { deny: 'guardrail: its check failed, so this call is refused. Retry, or ask the user.' } : next(e)
  })

  on('command.run', { command: 'allow' }, async ($, e) => {
    if (!isPerson(e.origin)) return { text: 'guardrail: /allow only counts when you type it yourself.' }
    const code = e.args.trim().toUpperCase()
    const c = codes.get(code)
    const now = await $.clock.now()
    if (!c || c.until < now) return { text: `guardrail: no held action with code ${code || '(none)'} (codes last 15 minutes).` }
    codes.delete(code)
    onceGrants.set(c.fp, now + GRANT_MS)
    return { text: `guardrail: allowed once: ${c.tool}. Claude can retry the identical call now.`, context: [`The user ran /allow ${code}: the held ${c.tool} call may be retried once, unchanged.`] }
  })

  on('command.run', { command: 'guardrail' }, async ($) => {
    const v = await read($, vault)
    return {
      text: [
        'guardrail is on:',
        `- secrets redacted from the transcript: ${redactOn ? `${Object.keys(v).length} so far` : 'off'}`,
        `- confidential terms checked before Codex: ${terms.length}`,
        `- personal-data scan before Codex: ${scanPii ? 'on' : 'off'}`,
        `- held actions waiting for /allow: ${codes.size}`,
      ].join('\n'),
    }
  })
}

// Asks the person; an answer of '' means nobody could be asked.
async function ask($: EngineInterface, question: string, options: string[]): Promise<string> {
  try {
    return await $.ui.ask(question.length > 1500 ? `${question.slice(0, 1500)}…` : question, { options, header: 'Guardrail' })
  } catch {
    return ''
  }
}

export function isPerson(origin: { kind?: string } | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge' || origin?.kind === 'sdk'
}

function preview(tool: string, args: Record<string, unknown>): string {
  const body = tool === 'Bash' ? String(args.command ?? '') : JSON.stringify(args, null, 1)
  return `${tool}: ${body.length > 900 ? `${body.slice(0, 900)}…` : body}`
}

async function fingerprint(tool: string, args: Record<string, unknown>): Promise<string> {
  const data = new TextEncoder().encode(`${tool}\n${stable(args)}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('')
}

// The folder a command runs in: the session's, moved by any leading `cd`.
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

async function codexDir($: EngineInterface, args: Record<string, unknown>, command: string): Promise<string | undefined> {
  for (const k of ['project_dir', 'projectDir', 'cwd', 'workspace', 'workdir']) {
    const v = args[k]
    if (typeof v === 'string' && v.startsWith('/')) return v
  }
  return command ? runDir($, command) : $.session.cwd()
}

// Ignored or untracked files in `dir` that a reader of the folder would find.
async function sensitiveFiles($: EngineInterface, dir: string, extra: RegExp[]): Promise<string[]> {
  const r = await $.process
    .run(['git', 'ls-files', '--others', '--exclude-standard', '--ignored', '--directory', '--no-empty-directory'], { cwd: dir, timeoutMs: 10_000 })
    .catch(() => null)
  const untracked = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  let lines = `${r?.exitCode === 0 ? r.stdout : ''}\n${untracked?.exitCode === 0 ? untracked.stdout : ''}`.split('\n').filter(Boolean)
  if (r?.exitCode !== 0) {
    // Not a git repo: look for the usual suspects directly.
    const f = await $.process
      .run(['find', dir, '-maxdepth', '4', '-not', '-path', '*/node_modules/*', '(', '-name', '.env*', '-o', '-name', '*.db', '-o', '-name', '*.sqlite*', '-o', '-name', '*.pem', '-o', '-name', '*.key', '-o', '-name', 'id_*', '-o', '-name', '*credentials*.json', ')'], { timeoutMs: 10_000 })
      .catch(() => null)
    lines = (f?.stdout ?? '').split('\n').filter(Boolean).map(p => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p))
  }
  return [...new Set(lines.filter(p => neverCommit(p.replace(/\/$/, ''), extra)))]
}

// What a commit would include: the index, plus tracked changes with --all.
// (A `git add -A && git commit` in one command is judged before the add runs,
// so with `addAll` the untracked files git would pick up count too.)
async function staged($: EngineInterface, command: string, gitC: string | undefined, tracked: boolean, untracked: boolean): Promise<string[]> {
  const here = await runDir($, command)
  const cwd = gitC ? (resolvePath(here, gitC, (await $.env.get('HOME')) ?? '') ?? here) : here
  const run = (argv: string[]) => $.process.run(argv, { cwd, timeoutMs: 10_000 }).then(r => (r.exitCode === 0 ? r.stdout : '')).catch(() => '')
  const parts = [await run(['git', 'diff', '--cached', '--name-only'])]
  if (tracked) parts.push(await run(['git', 'diff', '--name-only']))
  if (untracked) parts.push(await run(['git', 'ls-files', '--others', '--exclude-standard']))
  return parts.join('\n').split('\n').filter(Boolean)
}
