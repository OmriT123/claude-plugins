// Which tool calls are held for the person's yes: shell commands that destroy
// or publish, and connector tools that send, publish, deploy, delete or trade.
import { base, commands, gitDir, subcommand, type Cmd } from './shell'

// rm -rf on these is routine and never held.
const SAFE_RM = /(^|\/)(?:node_modules|dist|build|out|\.next|\.turbo|\.venv|venv|__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|coverage|htmlcov|\.cache|target|tmp)(\/.*)?$|^\/tmp\/|^\$TMPDIR|scratchpad/

const SQL_DANGER = /\b(?:drop\s+(?:table|database|schema|index)|truncate\s+(?:table\s+)?\w|delete\s+from\s+\S+\s*(?:;|$|"|')|flushall|flushdb|alter\s+table\s+\S+\s+drop)\b/i
const SQL_CLIENTS = new Set(['psql', 'mysql', 'sqlite3', 'mongosh', 'mongo', 'redis-cli', 'pgcli', 'mycli'])

// Why each command in `src` is held; empty when none is.
export function shellHolds(src: string): string[] {
  const why: string[] = []
  for (const c of commands(src)) {
    const r = holdOne(c)
    if (r) why.push(r)
  }
  return [...new Set(why)]
}

function holdOne(c: Cmd): string | null {
  const name = base(c.words[0])
  const args = c.words.slice(1)
  const flags = args.filter(a => a.startsWith('-'))
  const has = (...f: string[]) => flags.some(x => f.includes(x) || f.some(y => y.startsWith('--') && x.startsWith(`${y}=`)))
  const shortHas = (ch: string) => flags.some(x => /^-[A-Za-z]+$/.test(x) && x.includes(ch))

  if (name === 'rm') {
    const recursive = shortHas('r') || shortHas('R') || has('--recursive')
    const force = shortHas('f') || has('--force')
    const targets = args.filter(a => !a.startsWith('-'))
    const unsafe = (t: string) => /(^|\/)\.\.(\/|$)/.test(t) || !SAFE_RM.test(t)
    if (recursive && force && targets.some(unsafe)) return `rm -rf ${targets.join(' ')}`
    return null
  }

  // A script piped or here-stringed into a shell can't be read: hold it.
  if (/^(?:ba|z|da|k)?sh$/.test(name) && !args.some(a => !a.startsWith('-'))) return `${name} reading a script from its input`

  if (name === 'git') {
    if (c.words.some((w, i) => c.words[i - 1] === '-c' && /^alias\./i.test(w))) return 'git with an inline alias'
    const [sub, ...rest] = subcommand(c)
    const subFlags = rest.filter(a => a.startsWith('-'))
    const sf = (...f: string[]) => subFlags.some(x => f.some(y => x === y || x.startsWith(`${y}=`)))
    if (sub === 'push') {
      const short = subFlags.some(x => /^-[a-zA-Z]+$/.test(x) && /[fd]/.test(x))
      if (short || sf('--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune') || rest.some(a => /^[+:]/.test(a) || /:$/.test(a)))
        return 'git push that rewrites or deletes remote history'
    }
    if (sub === 'reset' && sf('--hard')) return 'git reset --hard (discards work)'
    if (sub === 'clean' && subFlags.some(x => /^-[a-zA-Z]*f/.test(x) || x === '--force')) return 'git clean -f (deletes untracked files)'
    if (sub === 'branch' && (sf('-D') || (sf('--delete', '-d') && sf('--force', '-f')))) return 'git branch -D (force-deletes a branch)'
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !sf('--staged', '-S')) return `git ${sub} . (discards working changes)`
    if (sub === 'stash' && (rest[0] === 'clear' || rest[0] === 'drop')) return `git stash ${rest[0]}`
    if (sub === 'filter-branch' || sub === 'filter-repo') return `git ${sub} (rewrites history)`
    return null
  }

  if (name === 'gh') {
    const [a, b] = subcommand(c)
    if (a === 'pr' && b === 'merge') return 'gh pr merge'
    if (a === 'release' && (b === 'create' || b === 'delete')) return `gh release ${b}`
    if (a === 'repo' && (b === 'delete' || b === 'archive' || b === 'edit')) return `gh repo ${b}`
    if ((a === 'secret' || a === 'variable') && (b === 'set' || b === 'delete')) return `gh ${a} ${b}`
    return null
  }

  if (SQL_CLIENTS.has(name) && SQL_DANGER.test(c.words.join(' '))) return `destructive SQL through ${name}`
  if (name === 'alembic' && args[0] === 'downgrade') return 'alembic downgrade'
  if (name === 'prisma' && ((args[0] === 'migrate' && args[1] === 'reset') || (args[0] === 'db' && args.includes('--force-reset')))) return 'prisma reset'
  if (/^python3?$/.test(name) && args.includes('manage.py') && args.includes('flush')) return 'django flush'

  if (name === 'railway') {
    const sub = args.find(a => !a.startsWith('-')) ?? ''
    if (['up', 'deploy', 'redeploy', 'down', 'delete', 'remove', 'rm'].includes(sub)) return `railway ${sub}`
    if (/^variables?$/.test(sub) && args.some(a => a === '--set' || a === '-s' || a === 'set' || a === 'delete')) return 'railway variables change'
    return null
  }

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && args[0] === 'publish') return `${name} publish`
  if (name === 'uv' && args[0] === 'publish') return 'uv publish'
  if (name === 'twine' && args[0] === 'upload') return 'twine upload'
  if (name === 'docker' && args[0] === 'push') return 'docker push'
  if (name === 'vercel' && (args.includes('--prod') || args[0] === 'deploy')) return 'vercel deploy'
  if (name === 'fly' || name === 'flyctl') return args[0] === 'deploy' ? 'fly deploy' : null
  if (name === 'gcloud' && args.includes('deploy')) return 'gcloud deploy'
  return null
}

// Connector tools are named mcp__<server>__<action>. These actions reach
// people or money, or can't be undone.
const ACTION_HOLD = /(?:^|[_-])(?:send|forward|reply|publish|deploy|redeploy|delete|trash|merge|share|order|instruction)(?:[_-]|$)/i
const NAMED_HOLD =
  /^mcp__.*__(?:push_files|create_or_update_file|actions_run_trigger|issue_write|(?:.*_)?(?:add|modify|remove|invite)_.*collaborators?|.*secrets?|set-variables|update-service|update-volume|update-domain|restart-service|accept-deploy|create-deployment|deploy-template|update-function-source-code|meeting_create|meeting_update|meeting_delete|enable_pr_auto_merge|create_repository|whatsapp_send)$/i
const READ_ONLY = /^(?:get|list|search|read|show|describe|fetch|query|view|whats_new)(?:[_-]|$)/i
// Routine PR conversation: the PR rules already govern these.
const ROUTINE = /^mcp__github__(?:add_reply_to_pull_request_comment|add_issue_comment|add_comment_to_pending_review|pull_request_review_write)$/

export function connectorHold(tool: string, extraHold?: RegExp, extraAllow?: RegExp): string | null {
  if (!tool.startsWith('mcp__')) return null
  if (extraAllow?.test(tool)) return null
  if (extraHold?.test(tool)) return `${tool} is on your hold list`
  if (ROUTINE.test(tool)) return null
  const action = tool.split('__').slice(2).join('__')
  if (READ_ONLY.test(action)) return null
  if (NAMED_HOLD.test(tool) || ACTION_HOLD.test(action)) return `${action} on ${tool.split('__')[1]} reaches people, money or can't be undone`
  return null
}

export const isCodexTool = (tool: string) => tool.startsWith('mcp__') && /codex/i.test(tool)

// `codex`, or codex through a package runner or node (`npx @openai/codex`, `node …/codex.js`).
export const runsCodex = (src: string) =>
  commands(src).some(c => {
    const name = base(c.words[0])
    if (name === 'codex') return true
    if (['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'node', 'bun', 'deno'].includes(name)) return c.words.slice(1, 4).some(w => /(^|[/@])codex(\.[cm]?js)?($|[@/])/i.test(w))
    return false
  })

// Commands that can carry data off this machine.
const SENDERS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'http', 'https', 'xh', 'npx', 'bunx', 'pnpx', 'uvx', 'gh', 'aws', 'gcloud', 'gsutil', 'railway', 'vercel', 'fly'])
export const sendsOut = (src: string) => /\bhttps?:\/\//.test(src) || commands(src).some(c => SENDERS.has(base(c.words[0])))

// Paths that `git add` names explicitly, and whether a commit takes all changes.
export function gitWrites(src: string): { adds: string[]; addAll: boolean; commitAll: boolean; commits: boolean; dir?: string } {
  let adds: string[] = []
  let commits = false
  let commitAll = false
  let addAll = false
  let dir: string | undefined
  for (const c of commands(src)) {
    if (base(c.words[0]) !== 'git') continue
    const [sub, ...rest] = subcommand(c)
    if (sub === 'add') {
      adds = adds.concat(rest.filter(a => !a.startsWith('-')))
      if (rest.some(a => a === '-A' || a === '--all' || a === '.' || a === '-u' || a === '--update')) addAll = true
    }
    if (sub === 'commit') {
      commits = true
      dir = gitDir(c) ?? dir
      if (rest.some(a => a === '--all' || /^-[a-zA-Z]*a/.test(a))) commitAll = true
    }
  }
  return { adds, addAll, commitAll, commits, ...(dir ? { dir } : {}) }
}
