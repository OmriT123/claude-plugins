// A small, conservative reader for the shell commands Claude runs: it finds
// the simple commands a line would start, so a guard can ask "does this run
// `git push --force`?" without being fooled by text that only mentions one
// (a commit message, a grep pattern). It is not a shell: where it can't tell,
// it errs toward seeing a command, which for a guard is the safe side.

export type Cmd = { words: string[] }

// Wrappers that run the command after them, and which of their options take a value.
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  time: new Set(['-f', '-o']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  caffeinate: new Set(['-t', '-w']),
  ionice: new Set(['-c', '-n', '-p']),
  chrt: new Set(),
  doas: new Set(['-u', '-C']),
}
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', '!', '{', '}', 'case', 'esac'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELLS = /^(?:.*\/)?(?:ba|z|da|k)?sh$/

// Every simple command `src` would run, including those inside $( ), backticks,
// `bash -c '...'` / `eval '...'` strings and heredocs fed to a shell.
export function commands(src: string): Cmd[] {
  const out: Cmd[] = []
  parse(src, out, 0)
  return out
}

function parse(src: string, out: Cmd[], depth: number): void {
  if (depth > 4) return
  let words: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  const pendingHeredocs: { tag: string; toShell: boolean }[] = []

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCmd = () => {
    endWord()
    if (words.length) emit(words, out, depth)
    words = []
  }

  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') word += src[i + 1]
      inWord = src[i + 1] !== '\n' || inWord
      i += 2
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      word += src.slice(i + 1, end < 0 ? src.length : end)
      inWord = true
      i = end < 0 ? src.length : end + 1
    } else if (c === '$' && src[i + 1] === "'") {
      let end = i + 2
      while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1
      word += src.slice(i + 2, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          word += src[i + 1]
          i += 2
        } else if (src[i] === '$' && src[i + 1] === '(') {
          const end = closing(src, i + 2)
          parse(src.slice(i + 2, end), out, depth + 1)
          word += '$(…)'
          i = end + 1
        } else if (src[i] === '`') {
          const end = src.indexOf('`', i + 1)
          parse(src.slice(i + 1, end < 0 ? src.length : end), out, depth + 1)
          word += '`…`'
          i = end < 0 ? src.length : end + 1
        } else {
          word += src[i]
          i++
        }
      }
      inWord = true
      i++
    } else if (c === '$' && src[i + 1] === '(') {
      const end = closing(src, i + 2)
      parse(src.slice(i + 2, end), out, depth + 1)
      word += '$(…)'
      inWord = true
      i = end + 1
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1)
      parse(src.slice(i + 1, end < 0 ? src.length : end), out, depth + 1)
      word += '`…`'
      inWord = true
      i = end < 0 ? src.length : end + 1
    } else if (c === '#' && !inWord) {
      const end = src.indexOf('\n', i)
      i = end < 0 ? src.length : end
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      // A here-string: its word is the command's input (code, if a shell reads it).
      endWord()
      words.push('<<<')
      i += 3
    } else if (c === '<' && src[i + 1] === '<') {
      endWord()
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(src.slice(i))
      if (m) {
        const first = words.find(w => !ASSIGN.test(w)) ?? ''
        pendingHeredocs.push({ tag: m[2] ?? '', toShell: SHELLS.test(first) })
        i += m[0].length
      } else {
        i += 2
      }
    } else if (c === '\n') {
      endCmd()
      i++
      // Heredoc bodies start on the next line; a body fed to a shell is code.
      for (const h of pendingHeredocs.splice(0)) {
        const re = new RegExp(`^[ \\t]*${h.tag}[ \\t]*$`, 'm')
        const rest = src.slice(i)
        const m = re.exec(rest)
        const body = m ? rest.slice(0, m.index) : rest
        if (h.toShell) parse(body, out, depth + 1)
        i += m ? m.index + m[0].length : rest.length
      }
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCmd()
      i++
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  endCmd()
}

// The index of the `)` closing a `$(` whose body starts at `from`.
function closing(src: string, from: number): number {
  let depth = 1
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      i = end < 0 ? src.length : end
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return src.length
}

// Drops what comes before the real command (VAR=x, sudo, timeout 30, if, !),
// then re-reads the string given to `bash -c` or `eval` as commands of its own.
function emit(raw: string[], out: Cmd[], depth: number): void {
  let k = 0
  const w0 = (i: number) => raw[i] ?? ''
  while (k < raw.length) {
    const w = w0(k)
    const valued = WRAPPERS[base(w)]
    if (ASSIGN.test(w) || KEYWORDS.has(w)) k++
    else if (valued) {
      k++
      for (;;) {
        const o = w0(k)
        if (o === '--') {
          k++
          break
        }
        if (o.startsWith('-') && o.length > 1) k += valued.has(o) ? 2 : 1
        else if (ASSIGN.test(o)) k++
        else if (base(w) === 'timeout' && /^\d/.test(o)) k++ // timeout's duration
        else break
      }
    } else break
  }
  const words = raw.slice(k)
  if (!words.length) return
  const name = base(words[0])
  if (name === 'eval') {
    parse(words.slice(1).join(' '), out, depth + 1)
    return
  }
  if (SHELLS.test(name)) {
    const hs = words.indexOf('<<<')
    const fed = hs > 0 ? words[hs + 1] : undefined
    if (fed !== undefined) {
      parse(fed, out, depth + 1)
      return
    }
    const ci = words.findIndex((w, j) => j > 0 && /^-\w*c\w*$/.test(w))
    const script = words[ci + 1]
    if (ci > 0 && script !== undefined) {
      parse(script, out, depth + 1)
      return
    }
  }
  out.push({ words })
}

export function base(word: string | undefined): string {
  if (!word) return ''
  return word.slice(word.lastIndexOf('/') + 1)
}

// For `git` and `gh`: the subcommand words after the tool's global options.
export function subcommand(cmd: Cmd): string[] {
  const [tool, ...rest] = cmd.words
  const name = base(tool)
  const takesValue = name === 'git' ? new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']) : new Set(['-R', '--repo'])
  let k = 0
  while (k < rest.length && (rest[k] ?? '').startsWith('-')) {
    k += takesValue.has(rest[k] ?? '') ? 2 : 1
  }
  return rest.slice(k)
}

// The directory a `git -C <dir>` command runs in, if it names one.
export function gitDir(cmd: Cmd): string | undefined {
  const i = cmd.words.indexOf('-C')
  return i > 0 ? cmd.words[i + 1] : undefined
}

// Leading `cd X &&` targets, so a command's own folder can be resolved.
export function leadingCd(src: string): string[] {
  const dirs: string[] = []
  const re = /^[\s({]*cd[ \t]+(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))[ \t]*(?:&&|;|\n)/
  let rest = src
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    dirs.push(m[1] ?? m[2] ?? m[3] ?? '')
    rest = rest.slice(m[0].length)
  }
  return dirs
}

export function resolvePath(from: string, to: string, home: string): string | null {
  if (/[$`*?]/.test(to) || to.startsWith('-') || /^~[^/]/.test(to)) return null
  const path = to === '~' || to.startsWith('~/') ? home + to.slice(1) : to.startsWith('/') ? to : `${from}/${to}`
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}
