# omri-plugins

Claude Code plugins and mods by Omri Tal. Add the marketplace once:

```
/plugin marketplace add OmriT123/claude-plugins
```

Then install what you want at user scope, for example `/plugin install guardrail@omri-plugins`.

| Plugin | What it does | Commands |
|---|---|---|
| `claudex` | Codex as a second-opinion teammate (planning, review, debugging). | `/claudex:*` |
| `guardrail` | Redacts secrets before Claude reads them; blocks secrets, confidential terms and personal data from reaching Codex; holds sends, deploys, orders, merges and destructive commands for your yes; refuses to commit `.env`, databases, keys and OAuth state. | `/guardrail`, `/allow <code>` |
| `verify-gate` | When a turn changes code, runs the project's own lint/typecheck/tests; failures go back to Claude (up to 2 retries), so "done" means green. | `/verify`, `/verify off\|on` |
| `push-gate` | Holds a push or PR that is large (100+ lines) or touches auth/migrations/schema until Codex reviewed that exact content; holds merges on red CI; shows running Codex reviews on the status line. | — |
| `resume` | `/park` saves where you left off (locally and as a Shared Memory checkpoint); `/where` tells you where you were; the next session in the repo opens with a reminder; long turns notify you when they end. | `/park [note]`, `/where`, `/checkpoint [note]` |
| `billing` | Times work per client and turns it into an exact bill (whole agorot, stated rounding, excl. VAT); on confirm, Claude records it in Shared Memory. Rates never leave the machine. | `/clock start <client> [note]`, `/clock stop`, `/clock list`, `/rate <client> <amount>`, `/bill <client> [confirm]` |

Options (confidential terms, thresholds, rounding) are set in `/config` or with `claude plugin configure <name>`. Sensitive options are stored in the OS keychain, never in this repo.

## How the holds work

A held action opens Claude's own question dialog, which works in the terminal, the desktop app and cloud sessions. If nobody can answer (a headless run), the action is refused with a five-letter code; typing `/allow <code>` yourself lets the identical call through once. Commands from plugins or the model don't count.

## Where they run

Hooks run wherever the plugin is installed: the terminal, the desktop Code tab and cloud sessions. Bands above the prompt and status-line entries show only in the terminal and the desktop app. In a cloud session, `/clock` and `/park` keep their state in the session's container, so bill or checkpoint before you leave.

## Recommended alongside (not in this marketplace)

- `/plugin enable cc-plugin-you-should-know@builtin`: Claude Code's built-in side agent that flags what you might miss on long tasks.
- `/plugin install security-guidance@claude-plugins-official`: Anthropic's non-blocking security review of edits and commits.
- Trail of Bits skills: `/plugin marketplace add trailofbits/skills`, then install the static-analysis and differential-review skills.
- `usage-meter` from `hamzafer/claude-code-mods` (MIT, reviewed at commit `77f1ebc`: no network or process calls): 5-hour and 7-day plan usage above the prompt. `/plugin marketplace add hamzafer/claude-code-mods`, then `/plugin install usage-meter@claude-code-mods`.

## Developing

Each mod lives in `mods/<name>/` with `hooks/`, `tests/` and, when it keeps session state, `types/`. Check one with `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
