import { describe, expect, mock, test } from 'claude-code/testing'

import { isPerson } from '../hooks/register'
import { connectorHold, gitWrites, runsCodex, sendsOut, shellHolds } from '../hooks/rules'
import { Vault, findPii, findSecrets, findTerms, neverCommit } from '../hooks/secrets'

// Synthetic, never-valid values shaped like real secrets.
const ANTHROPIC = `sk-ant-api03-${'A1b2C3d4'.repeat(4)}`
const GITHUB = `ghp_${'Z9y8X7w6'.repeat(5)}`
const PH_GITHUB = new Vault().redact(GITHUB).text
const PH_ANTHROPIC = new Vault().redact(ANTHROPIC).text

describe('shell holds', () => {
  test('text that only mentions a command is not held', () => {
    expect(shellHolds('git commit -m "never git push --force"')).toEqual([])
    expect(shellHolds("grep -r 'rm -rf /' docs")).toEqual([])
    expect(shellHolds('git push origin feature')).toEqual([])
    expect(shellHolds('rm -rf node_modules dist .venv')).toEqual([])
  })

  test('destructive or publishing commands are held, however they are wrapped', () => {
    expect(shellHolds('git push --force origin main').length).toBe(1)
    expect(shellHolds('git push origin +main').length).toBe(1)
    expect(shellHolds('cd app && sudo rm -rf /var/data').length).toBe(1)
    expect(shellHolds("bash -c 'git reset --hard HEAD~1'").length).toBe(1)
    expect(shellHolds('echo "$(git push -f)"').length).toBe(1)
    expect(shellHolds('psql "$DATABASE_URL" -c "DROP TABLE users"').length).toBe(1)
    expect(shellHolds('railway up --detach').length).toBe(1)
    expect(shellHolds('gh pr merge 12 --squash').length).toBe(1)
    expect(shellHolds('uv publish').length).toBe(1)
  })

  test('git add / commit are read for the never-commit check', () => {
    expect(gitWrites('git add .env src/app.py && git commit -m x')).toEqual({ adds: ['.env', 'src/app.py'], addAll: false, commitAll: false, commits: true })
    expect(gitWrites('git add -A && git commit -am x').addAll).toBe(true)
  })
})

describe('review regressions', () => {
  test('wrapper options, combined flags, piped scripts, aliases and .. are held', () => {
    for (const cmd of [
      'git push -fu origin main',
      'git push origin main --force',
      'env -u FOO git push -f',
      'sudo -u root git push --force',
      'nice -n 10 rm -rf /srv/data',
      'timeout -s KILL 30 git reset --hard',
      "bash <<< 'git push -f'",
      "echo 'git push -f' | bash",
      'git -c alias.p="push --force" p',
      'rm -rf /tmp/../home/user',
      'rm -rf node_modules/../src',
      '(cd ../billing && git push -f)',
    ])
      expect(shellHolds(cmd).length).toBeGreaterThan(0)
  })

  test('codex through a package runner counts as Codex; network commands are known', () => {
    expect(runsCodex('npx @openai/codex exec "hi"')).toBe(true)
    expect(runsCodex('node ./node_modules/.bin/codex.js review')).toBe(true)
    expect(runsCodex('npx prettier .')).toBe(false)
    expect(sendsOut('curl https://x.example')).toBe(true)
    expect(sendsOut('echo hi > out.txt')).toBe(false)
  })

  test('lower-case, quoted and bearer secrets are found', () => {
    expect(findSecrets('{"API_KEY": "abcd1234efgh5678"}')).toEqual(['abcd1234efgh5678'])
    expect(findSecrets('api_key=abcd1234efgh5678')).toEqual(['abcd1234efgh5678'])
    expect(findSecrets('Authorization: Bearer abcdefghij0123456789xyz')).toEqual(['abcdefghij0123456789xyz'])
  })

  test('direct commits, workflow triggers and access grants are held', () => {
    for (const t of ['mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__github__actions_run_trigger', 'mcp__github__issue_write', 'mcp__Higgsfield__website_secrets', 'mcp__Zoom_for_Claude__canvas_add_file_collaborators'])
      expect(connectorHold(t)).not.toBeNull()
    expect(connectorHold('mcp__Zoom_for_Claude__canvas_list_file_collaborators')).toBeNull()
  })
})

describe('connector holds', () => {
  test('sends, orders, deploys and deletes are held; reads and drafts are not', () => {
    expect(connectorHold('mcp__Gmail__send_message')).not.toBeNull()
    expect(connectorHold('mcp__wa-connector__whatsapp_send')).not.toBeNull()
    expect(connectorHold('mcp__Interactive_Brokers_IBKR__create_order_instruction')).not.toBeNull()
    expect(connectorHold('mcp__Railway__set-variables')).not.toBeNull()
    expect(connectorHold('mcp__github__merge_pull_request')).not.toBeNull()
    expect(connectorHold('mcp__Gmail__create_draft')).toBeNull()
    expect(connectorHold('mcp__Interactive_Brokers_IBKR__get_order_instructions')).toBeNull()
    expect(connectorHold('mcp__github__add_issue_comment')).toBeNull()
    expect(connectorHold('mcp__Shared_Memory__memory_update')).toBeNull()
    expect(connectorHold('mcp__Gmail__send_message', undefined, /Gmail/)).toBeNull()
  })
})

describe('secrets', () => {
  test('finds secret shapes and only the password of a URL', () => {
    expect(findSecrets(`key=${ANTHROPIC}`)).toEqual([ANTHROPIC])
    expect(findSecrets('postgres://app:s3cretPass@db:5432/x')).toEqual(['s3cretPass'])
    expect(findSecrets('API_KEY = settings.api_key')).toEqual([])
    expect(findSecrets('OPENAI_API_KEY=your_key_here')).toEqual([])
    expect(findSecrets('STRIPE_SECRET=abc123def456ghi789')).toEqual(['abc123def456ghi789'])
  })

  test('the vault keeps placeholders stable and restores them', () => {
    const v = new Vault()
    const a = v.redact(`one ${GITHUB} two ${GITHUB}`)
    expect(PH_GITHUB).toMatch(/^\[\[REDACTED:secret-[0-9a-f]{8}\]\]$/)
    expect(a.text).toBe(`one ${PH_GITHUB} two ${PH_GITHUB}`)
    expect(v.redact(`again ${GITHUB}`).text).toBe(`again ${PH_GITHUB}`)
    expect(v.restore(`x ${PH_GITHUB} y`)).toBe(`x ${GITHUB} y`)
    // Two vaults built apart never give one name to two secrets.
    expect(new Vault().redact(ANTHROPIC).text).not.toBe(new Vault().redact(GITHUB).text)
  })

  test('confidential terms match whole words, in Hebrew too', () => {
    expect(findTerms('review the Acme invoice flow', ['acme', 'Globex'])).toEqual(['acme'])
    expect(findTerms('acmeish', ['acme'])).toEqual([])
    expect(findTerms('לקוח: גלובקס', ['גלובקס'])).toEqual(['גלובקס'])
  })

  test('personal data: emails, Israeli phones, Luhn-valid cards', () => {
    expect(findPii('mail dana@client.co.il or call 052-123-4567')).toEqual(['dana@client.co.il', '052-123-4567'])
    expect(findPii('card 4242 4242 4242 4242')).toEqual(['card …4242'])
    expect(findPii('order 1234 5678 9012 3456')).toEqual([])
  })

  test('never-commit paths', () => {
    for (const p of ['.env', 'app/.env.production', 'data/app.db', 'oauth_state.json', 'out/recovery-bundle.tar', 'id_ed25519', 'certs/server.key'])
      expect(neverCommit(p)).toBe(true)
    for (const p of ['.env.example', 'src/env.py', 'docs/keys.md']) expect(neverCommit(p)).toBe(false)
  })
})

// Stands for the engine beneath the mod: tools run, nobody answers dialogs.
function engine(on: any, opts: { staged?: string; ran?: any[] } = {}) {
  const ran = opts.ran ?? []
  mock.clock(on, { now: Date.parse('2026-10-18T09:00:00Z') })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_$: any, e: any) => ({
    value: { exitCode: 0, stdout: e.argv.includes('--cached') ? (opts.staged ?? '') : '', stderr: '' },
  }))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') throw new Error('nobody to ask')
    ran.push(e)
    return { result: 'ok' }
  })
  return ran
}

describe('guardrail in a session', () => {
  test('a held command is refused with a code, and /allow from anyone but the person does nothing', async ($: any, on: any) => {
    const ran = engine(on)
    const held = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    expect(held.deny).toMatch(/\/allow [A-Z0-9]{5}/)
    expect(ran.length).toBe(0)
    const code = /\/allow ([A-Z0-9]{5})/.exec(held.deny)![1]
    // The kit runs commands as a plugin would: only a typed /allow counts.
    const r = await $.command.run({ command: 'allow', args: code })
    expect(r.text).toMatch(/only counts when you type it yourself/)
    const again = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    expect(again.deny).toBeDefined()
    expect(ran.length).toBe(0)
  })

  test('only the person counts as the person', () => {
    expect(isPerson({ kind: 'composer' })).toBe(true)
    expect(isPerson({ kind: 'bridge' })).toBe(true)
    expect(isPerson({ kind: 'plugin' })).toBe(false)
    expect(isPerson({ kind: 'task-notification' })).toBe(false)
    expect(isPerson(undefined)).toBe(false)
  })

  test('a codex command in a chain does not switch the other checks off', async ($: any, on: any) => {
    const ran = engine(on, { staged: '.env\n' })
    expect((await $.tool.call({ tool: 'Bash', command: 'codex --version; git push --force origin main' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'git add .env && git commit -m x; codex --help' })).deny).toBeDefined()
    expect(ran.length).toBe(0)
  })

  test('committing a staged .env is refused', async ($: any, on: any) => {
    const ran = engine(on, { staged: 'src/a.py\n.env\n' })
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"' })
    expect(r.deny).toMatch(/\.env/)
    expect(ran.length).toBe(0)
  })

  test('a Codex call carrying a secret or a confidential term is blocked', { options: { confidentialTerms: 'Acme' } }, async ($: any, on: any) => {
    const ran = engine(on)
    const a = await $.tool.call({ tool: 'mcp__codex__codex_review', prompt: `why does ${ANTHROPIC} fail?` })
    expect(a.deny).toMatch(/Codex/)
    const b = await $.tool.call({ tool: 'mcp__codex__codex_review', prompt: 'review the Acme billing module' })
    expect(b.deny).toMatch(/Codex/)
    const c = await $.tool.call({ tool: 'mcp__codex__codex_review', prompt: 'review the billing module' })
    expect(c.deny).toBeUndefined()
    expect(ran.length).toBe(1)
  })

  test('local tools get real values back for placeholders; connectors do not', async ($: any, on: any) => {
    const ran = engine(on)
    // Seed the vault the way a session does: through a row Claude would read.
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `token ${GITHUB}` }] } })
    await $.tool.call({ tool: 'Bash', command: `echo ${PH_GITHUB}` })
    expect(ran[0].command).toBe(`echo ${GITHUB}`)
    await $.tool.call({ tool: 'mcp__notes__write_note', text: `x ${PH_GITHUB}` })
    expect(ran[1].text).toBe(`x ${PH_GITHUB}`)
    // A command that can send data out keeps the placeholder unless the person says yes.
    await $.tool.call({ tool: 'Bash', command: `curl -d k=${PH_GITHUB} https://example.invalid` })
    expect(ran[2].command).toContain(PH_GITHUB)
  })

  test('rows the model reads are redacted', async ($: any, on: any) => {
    engine(on)
    const rows = mock.session(on)
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `the key is ${ANTHROPIC}` }] } })
    const text = JSON.stringify(rows.appended().map(r => r.message))
    expect(text).not.toContain(ANTHROPIC)
    expect(text).toContain(PH_ANTHROPIC)
  })
})
