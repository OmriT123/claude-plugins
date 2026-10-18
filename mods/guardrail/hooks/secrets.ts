// What counts as a secret, a confidential term or a file that must never be
// committed, and the redaction that keeps secrets out of what the model reads.

// High-precision secret shapes. Each regex either matches the secret whole or
// marks the secret as its `secret` group (a password inside a URL, the value
// of KEY=value), so only that part is replaced.
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]+:(?<secret>[^@\s]{3,})@/g,
  // KEY=value where the value looks generated (letters and digits, 12+ chars),
  // not code (`TOKEN = settings.token`) or a placeholder (`your_key_here`).
  /\b[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_]*["']?[ \t]*[=:][ \t]*["']?(?<secret>(?=[\w+/=-]*\d)(?=[\w+/=-]*[A-Za-z])[\w+/=-]{12,})(?![\w+/=.([-])/gi,
  /\b[Bb]earer[ \t]+(?<secret>[A-Za-z0-9._~+/-]{20,}=*)/g,
]

export const PLACEHOLDER = /\[\[REDACTED:secret-([0-9a-f]{8})\]\]/g

// Named by a hash of the secret, so two writers never hand one name to two
// different secrets.
const placeholderFor = (secret: string) => `[[REDACTED:secret-${fnv1a(secret)}]]`

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Patterns given in the options, one per line or comma-separated; a pattern
// that does not compile is skipped (and reported by `invalid`).
export function compileExtra(text: string | undefined): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = []
  const invalid: string[] = []
  for (const src of split(text)) {
    try {
      patterns.push(new RegExp(src, 'g'))
    } catch {
      invalid.push(src)
    }
  }
  return { patterns, invalid }
}

export function split(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Every secret found in `text`, as the exact strings that would be replaced.
export function findSecrets(text: string, extra: RegExp[] = []): string[] {
  const found = new Set<string>()
  for (const re of [...SECRET_SHAPES, ...extra]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const s = m.groups?.secret ?? m[0]
      if (s && !s.startsWith('[[REDACTED:')) found.add(s)
    }
  }
  return [...found]
}

// Keeps secret <-> placeholder pairs stable for the session, so the same
// secret always reads as the same placeholder and can be put back.
export class Vault {
  constructor(public entries: Record<string, string> = {}) {}

  private byValue(): Map<string, string> {
    return new Map(Object.entries(this.entries).map(([k, v]) => [v, k]))
  }

  // Replaces every secret in `text`; `changed` is false when nothing was.
  redact(text: string, extra: RegExp[] = []): { text: string; changed: boolean } {
    const secrets = findSecrets(text, extra)
    if (!secrets.length) return { text, changed: false }
    const known = this.byValue()
    // Longest first, so a secret that contains another is replaced whole.
    secrets.sort((a, b) => b.length - a.length)
    let out = text
    for (const s of secrets) {
      let ph = known.get(s)
      if (!ph) {
        ph = placeholderFor(s)
        this.entries[ph] = s
        known.set(s, ph)
      }
      out = out.split(s).join(ph)
    }
    return { text: out, changed: out !== text }
  }

  // Puts the real values back for a tool that runs on this machine.
  restore(text: string): string {
    return text.replace(PLACEHOLDER, m => this.entries[m] ?? m)
  }
}

// Applies `fn` to every string inside a JSON-like value.
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn)
    return out as T
  }
  return value
}

// Confidential terms (client names and the like) found in `text`, matched as
// whole words, ignoring case.
export function findTerms(text: string, terms: string[]): string[] {
  return terms.filter(t => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}($|[^\\p{L}\\p{N}])`, 'iu').test(text))
}

// Personal data that should not reach a third party: emails, Israeli phone
// numbers, card numbers passing the Luhn check.
export function findPii(text: string): string[] {
  const hits: string[] = []
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    if (!/@(?:example\.(?:com|org)|users\.noreply\.github\.com|anthropic\.com)$/i.test(m[0])) hits.push(m[0])
  }
  for (const m of text.matchAll(/(?:\+972[-\s]?|\b0)5\d[-\s]?\d{3}[-\s]?\d{4}\b/g)) hits.push(m[0])
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 13 && luhn(digits)) hits.push(`card …${digits.slice(-4)}`)
  }
  return [...new Set(hits)]
}

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Files that must never be committed or pushed: secrets, local databases,
// OAuth state, recovery bundles, private keys.
const NEVER_COMMIT: RegExp[] = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$|sample$|template$|dist$|defaults$)[^/]+$/,
  /\.(?:db|sqlite|sqlite3|db-journal|db-wal|db-shm)$/i,
  /(^|\/)(?:credentials|client_secret|service[-_]account)[^/]*\.json$/i,
  /oauth[^/]*state/i,
  /recovery[-_]?bundle/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
]

export function neverCommit(path: string, extra: RegExp[] = []): boolean {
  return [...NEVER_COMMIT, ...extra].some(re => {
    re.lastIndex = 0
    return re.test(path)
  })
}
