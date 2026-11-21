# hinty-agents

Approve or deny your AI coding agent's permission prompts, and follow what each session is doing, from Hinty
smart-glasses or the Hinty web panel while you are away from the desk. Claude Code, Codex CLI and Grok Build today;
OpenClaw and Hermes later.

```
api       asks to run: npm run test:e2e        [Allow once] [Deny]
web       done: fixed the signup form, 3 files
```

It is a small Node.js service that runs on your computer, plus a Claude Code plugin (two hooks and a mod). The code
is open because it approves commands on your machine: read it before you run it.

## How it works

```
Claude Code ──PermissionRequest / SessionStart hooks──┐
            ──mod (session status, instructions)──────┤ 127.0.0.1, random port, secret
                                                      ▼
                                  hinty-agents service (one per computer)
                                                      │ Socket.IO, bridge token
                                                      ▼
                         Hinty relay (api.v1.hinty.eu/agents-link, memory only)
                                                      │
                                     glasses (Even G2, hinty.eu/g) / web panel
```

- **PermissionRequest hook** (`claude-plugin/hook.cjs`): when Claude Code would ask you for permission, the hook
  asks the service. The service sends a card (session label, tool, command text) and waits. Your answer from the
  glasses or the panel comes back as *allow once* or *deny*. The terminal prompt stays open at the same time;
  whichever answer comes first wins.
- **SessionStart hook**: registers the session (label = folder name, `-2`, `-3`... for repeats) and, while this
  computer is paired, asks the agent to end each answer with one short line starting with 👓 (what it did or what
  it asks you). That line is what the glasses show.
- **Mod** (`claude-plugin/hooks/register.mjs`, runs inside Claude Code without starting processes): while away mode
  is on it reports the session's state (running, asking, done, the 👓 line) and delivers instructions you send from
  the glasses as a normal user message (`$.prompt.submit({ text, asUser: true })`), also to an idle session. It
  identifies its session with `$.session.id()`, the same id the hooks receive as `session_id`.

## Security

| Rule | What the code does |
|---|---|
| No answer means no decision | Service down, away mode off, link lost, refused by the relay, time up (840 s, before the hook's 900 s limit), any error: the hook prints nothing and exits 0, so Claude Code asks in the terminal as usual. It never approves on its own. |
| Allow once or deny, nothing else | The hook can print exactly two fixed JSON answers. It never sends `updatedInput` or `updatedPermissions`, so a remote answer can neither change the command nor widen your permission rules. Claude Code's own `deny` rules still win. |
| A decision must match | Accepted only while away mode is on, for a request id (128 random bits, single use) this service created, still waiting, not expired, and with the SHA-256 hash of exactly what was asked (`rid`, session, sub-agent, tool, tool input). A replayed or forged decision is ignored. |
| Away mode is opt-in | Off by default and after every restart. While off, nothing about your sessions leaves the computer (no status, no prompts, no answers) and the hook answers at once. It turns itself off after 12 hours. |
| Secrets are masked | Before any text leaves: `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, JWTs, private keys, credentials in URLs and similar are replaced with `***`. Best effort, not a guarantee. |
| Local port | Listens on `127.0.0.1` only, random port, a random secret header on every request (`~/.hinty-agents/daemon.json`, readable by you only). Requests with an `Origin`, `Sec-Fetch-*` or foreign `Host` header (browsers) are refused. Every answer carries an HMAC proof, so a process that grabbed a stale port cannot answer for the service. |
| The relay keeps no content | The Hinty server holds cards and session status in memory only (minutes); the database stores only a hash of this computer's token. Content crosses the server in transit (TLS). End-to-end encryption is planned. |

Logs (`~/.hinty-agents/daemon.log`) hold identifiers and counts only, never commands or answers.

## Install

Requirements: Node.js 20+, Claude Code (`claude`) with mods enabled (default since 2.1.287), a Hinty account.

Not on npm yet; run it from a clone:

```bash
git clone <this repository> hinty-agents
cd hinty-agents
npm install
npx hinty-agents
```

The wizard checks Node and Claude Code, shows a pairing code (type it in the Hinty panel: Voice Assistant → Agents),
stores the token in `~/.hinty-agents/config.json`, installs the Claude Code plugin with Claude Code's own commands,
and starts the service. The plugin step is the same as running:

```bash
claude plugin marketplace add <path to this folder> --scope user
claude plugin install hinty-agents@hinty-agents --scope user
```

New Claude Code sessions load it (open ones: `/reload-plugins` or restart). Then, when you leave the desk:

```bash
npx hinty-agents away on      # or switch it on in the panel
npx hinty-agents away off     # back at the desk
```

## Commands

| Command | |
|---|---|
| `npx hinty-agents` | set up (options: `--no-install`, `--no-start`, `--label <name>`) |
| `status` | service, link, away mode, sessions |
| `away on\|off` | away-from-desk mode |
| `install <claude\|codex\|grok>` / `uninstall <...>` | add or remove an agent's integration (`install grok --ask-shell`: see Grok Build) |
| `doctor` | checks Node, Claude Code, the plugin (`claude plugin validate`), the service, the link, the hook and whether the mod reports in |
| `unpair` | disconnect this computer from your account and delete the token |
| `voice install` / `status` / `remove` | local speech to text for dictation from the glasses (see Voice) |
| `start` / `stop` | start or stop the background service (`stop` also keeps it from starting with the next session) |

After a reboot the SessionStart hook starts the service again (unless you ran `stop`).

Environment: `HINTY_AGENTS_API` (server for a new pairing, default `https://api.v1.hinty.eu`),
`HINTY_AGENTS_HOME` (data folder, default `~/.hinty-agents`).

## Codex CLI

```bash
npx hinty-agents install codex      # merges 6 hooks into $CODEX_HOME/hooks.json (default ~/.codex)
npx hinty-agents uninstall codex    # removes exactly those entries
```

Needs Codex CLI 0.171 or newer for instructions (`codex queue`); permission cards and status work with any version that
has hooks. Your own `hooks.json` entries and `config.toml` are never touched: install adds our entries, keeps a copy of
your file once (`hooks.json.hinty-agents.bak`), and uninstall removes only ours. If `config.toml` also declares `[hooks]`
or switches hooks off, install says so.

**Trust (once).** Codex runs a new hook only after you trust it. At its next start Codex shows *Hooks need review*:
choose *Trust all and continue* (or review them later with `/hooks`). Until then nothing of Hinty runs in Codex.

| | |
|---|---|
| Permission cards | `PermissionRequest` hook: allow once or deny from the glasses or the panel. Same rules as Claude Code (N1-N3, N8, N11). |
| Session state | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`: the session appears next to your Claude Code ones (`agent: codex`), with the 👓 line from the final answer. |
| Instructions | `codex queue --thread <session> --message <text>`: Codex shows it as your next message, also in an idle session at the prompt. No shell is involved (the text is one argument). Fallback for a Codex without `queue`: the `Stop` hook is held (up to 9 minutes, 8 instructions in a row) and answers `{"decision":"block","reason":<text>}`; Codex then continues with it. |

Limits worth knowing:
- **While a card waits, Codex shows no prompt in the terminal.** Codex asks you only after the hook has answered (checked
  live on 0.171), unlike Claude Code, which shows both at once. If you are back at the desk, `npx hinty-agents away off`
  (or switch it off in the panel) releases the waiting hook at once and the terminal asks as usual (measured: ~0.4 s).
  Unanswered cards expire after 570 s with the same result.
- Away mode off, service down or link lost: the hooks print nothing and finish in ~0.1 s (median 127 ms on Windows).
- With the held-`Stop` fallback the Codex input bar shows "Running hooks" while the hook waits.
- An instruction that is a Codex slash command is not run as one: every instruction is sent as plain text (see Instructions
  are plain text below).

## Grok Build

```bash
npx hinty-agents install grok                # session status only
npx hinty-agents install grok --ask-shell    # plus a card for every risky shell command
npx hinty-agents uninstall grok
```

Writes `~/.grok/hooks/hinty.json` (an existing file of that name that is not ours is backed up and restored by
uninstall). Not tested on a live Grok Build (it needs a paid xAI account); the hook scripts and the whole bridge are tested
with Grok's documented hook input and output (docs.x.ai/build/features/hooks).

**Read this before `--ask-shell`: Grok hooks fail open.** Grok can block a step only from `PreToolUse`, and when the hook
crashes, times out or the service is down, Grok **runs the step**. So with `--ask-shell`:
- a card appears for each shell command that is not on the harmless list (`ls`, `pwd`, `cat`, `git status|diff|log`, ...;
  every chained segment must match, and `$(...)`, backticks and redirection are never harmless). Own list:
  `"grok": {"except": [...]}` in `~/.hinty-agents/config.json`;
- **Deny** vetoes the step. **Allow** only means "no veto": Grok's own permission prompt still applies;
- if nobody answers within 280 s, the service is down, away mode is off or anything fails, the step runs (as Grok does with
  any failing hook). Do not use this as a security boundary; Grok's own `deny` rules and sandbox are the guarantee.

Without `--ask-shell` only the passive hooks are installed. Grok ignores the output of those, so there is no glasses line
and **instructions from the glasses are not supported** for Grok sessions.

## Instructions are plain text

Whatever you send from the glasses or the panel reaches the agent as an ordinary message, never as a command: Claude Code
treats a leading `!` as bash mode (no permission), `/` as a slash command and `#` as a memory note, and OpenClaw runs a
chat line `/approve <id> allow-always` as an approval. The service puts a zero-width space in front of every line that,
after leading white space, starts with `/`, `!`, `#`, `@` or `$`. Other text is passed byte for byte.

## Voice (dictate to your agents from the glasses)

Local speech to text, free, no cloud API. Say an instruction in the glasses' dictation view; the text comes back to the
glasses, you choose Send / Edit / Add / Cancel, and only Send reaches the agent.

```bash
npx hinty-agents voice install      # engine + default model (downloads ~0.64 GB)
npx hinty-agents voice status
npx hinty-agents voice remove       # deletes the engine and every model
```

- **Engine:** `sherpa-onnx-node` 2.0.2 (Apache 2.0), installed on demand into `~/.hinty-agents/voice/`, never added to this
  package's dependencies. Models go to `~/.hinty-agents/models/<id>/`; each file is checked against a pinned size and SHA-256
  and written atomically. A running service says `hello` again with `stt: true` right after the install.
- **Models:** `parakeet-v3` (default; NVIDIA Parakeet TDT 0.6b v3 int8, 25 European languages incl. Polish, CC BY 4.0, ~640 MB,
  ~1 GB RAM while in use), `whisper-small` (358 MB) and `whisper-turbo` (989 MB, too slow on CPU for dictation) with
  `voice install --model <id>`. Silero VAD (0.6 MB) splits speech into stretches that are recognized while you are still
  talking. The model loads when dictation starts and is released after 10 idle minutes.
- **Developer words:** the default model is biased towards ~130 words like commit, rebase, README, endpoint, package.json
  (`src/stt/hotwords.txt`). Add your own, one per line (`word :2.5` sets a score), in `~/.hinty-agents/hotwords.txt`.
  `HINTY_AGENTS_HOTWORDS=off` turns the bias off.
- **Privacy:** audio exists only in memory while one utterance is recognized (at most 35 s, one at a time) and is dropped
  afterwards; nothing is written to disk and logs hold counts only. Recognition runs on this computer. With away mode off
  the bridge reads nothing: it only answers `away_off`. Only the recognized text goes back to your own glasses screen.
- **Accuracy:** measured in `testy-e2e/agenci/stt/WYNIKI.md` of the Hinty repository. English commands are near perfect; Polish
  sentences with English jargon often need a fix in the preview step.

## Uninstall

```bash
npx hinty-agents uninstall claude   # removes the plugin and the marketplace entry
npx hinty-agents unpair             # revokes this computer and deletes the token
npx hinty-agents stop
```

Then delete the folder and `~/.hinty-agents`.

## Development

```bash
npm test                                      # unit tests (node --test)
claude --plugin-dir ./claude-plugin           # load the plugin from this folder without installing it
claude plugin validate ./claude-plugin        # check the manifest, hooks and mod
```

Use `HINTY_AGENTS_HOME` and `HINTY_AGENTS_API` to keep a test service away from your real one. Plain JavaScript with
JSDoc types (no build step); the only dependency is `socket.io-client` (the speech engine and models are installed on demand by `voice install`). The mod's types come from Claude Code: once
it has loaded the plugin, `claude-plugin/.claude-plugin/types/` holds them.

Known limits:
- In auto mode Claude Code asks for permission only when its classifier does, so there are fewer cards.
- An answer typed at the keyboard does not end the waiting hook; the card closes at the session's next activity
  (reported by the mod), or when the request expires.
- If mods are disabled (`disableAllHooks`, `allowManagedModsOnly`), permission cards still work but session status
  and instructions do not. Planned fallback: hold the `Stop` hook while away and hand the instruction over as
  `additionalContext`.
- Pick-from-a-list questions (AskUserQuestion) show as "asks, answer at the computer".

## License

MIT
