# hinty-agents

Approve or deny your AI coding agent's permission prompts, and follow what each session is doing, from Hinty
smart-glasses or the Hinty web panel while you are away from the desk. Claude Code, Codex CLI, Grok Build, OpenClaw and Hermes Agent.

```
api       asks to run: npm run test:e2e        [Allow once] [Deny]
web       done: fixed the signup form, 3 files
```

It is a small Node.js service that runs on your computer, plus a Claude Code plugin (two hooks and a mod). The code
is open because it approves commands on your machine: read it before you run it.

## How it works

```
Claude Code ──PermissionRequest / SessionStart hooks──┐
            ──mod (session status, instructions)──────┤ 127.0.0.1, random port, signed requests
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

### Who can do what

The parts that can act on your computer are the agent (your own Claude Code, Codex... session), this service, and
whoever sends it events through the Hinty relay. The relay is the Hinty server; anyone who controls your Hinty account
(password, session) can use it too. Plan for that:

| | The relay / your Hinty account can | It can never |
|---|---|---|
| Away mode OFF | see that this computer is paired and online (`hello`: host name, which agents are installed, voice yes/no), switch away mode **on only if you allowed it** (below) | see sessions, prompts or answers; send instructions; approve anything |
| Away mode ON | see session names, status lines, permission cards and the last answers; **send instructions** that reach an open agent session as your message; **allow once or deny** a waiting permission request whose card shows everything that will run; switch away mode off | widen your permission rules or change a command (only *allow once* / *deny* exist), allow a request whose card is incomplete, act without an open agent session, read files on its own, extend away mode past 12 hours |

So while away mode is on, the relay and your Hinty account are trusted like a person at your keyboard who can type
into an open session and press *allow once*. That is the point of the feature; keep it on only while you are away,
and protect your Hinty account. End-to-end encryption between this computer and your screen is planned.
"A replayed or forged decision is ignored" below protects you against third parties, not against the relay itself.

### Rules in the code

| Rule | What the code does |
|---|---|
| No answer means no decision | Service down, away mode off, link lost, refused by the relay, time up (840 s, before the hook's 900 s limit), another protocol version, any error: the hook prints nothing and exits 0, so the agent asks in the terminal as usual. It never approves on its own. |
| Allow once or deny, nothing else | The hook can print exactly two fixed JSON answers. It never sends `updatedInput` or `updatedPermissions`, so a remote answer can neither change the command nor widen your permission rules. The agent's own `deny` rules still win. |
| A decision must match | Accepted only while away mode is on, for a request id (128 random bits, single use) this service created, still waiting, not expired, and with the SHA-256 hash of exactly what was asked (`rid`, session, sub-agent, tool, tool input). A replayed or forged decision from anyone else is ignored. |
| Incomplete cards can only be denied | When the card does not show everything that will run (something was cut, a secret was masked or a value was left visible on purpose, invisible or control characters were removed, blank lines folded, a field has a shape the bridge does not know), it is sent with `part: true`. The glasses and the panel offer only *Deny*, and **this service itself refuses a remote *allow*** for it, whatever the relay says. Approve such a request in the terminal. Every cut on a card is marked (`[… cut: 7,000 of 48,211 characters shown]`). |
| Away mode is opt-in | Off by default and after every restart. While off, nothing about your sessions leaves the computer and the hook answers at once. It turns itself off 12 hours after it was switched on. |
| Remote switch-on needs your consent | The Hinty panel or the glasses can switch away mode **on** only if you allowed it on this computer (the setup wizard asks once; `npx hinty-agents remote-away on\|off`; default **off**). Without it a remote switch-on is refused and logged. A remote switch-on never extends the 12 hours, and it is always visible here: Claude Code's status line and a toast, a system notification, `npx hinty-agents status`, the log. Switching it **off** remotely always works. |
| Pairing shows the account | After the code is typed in the panel, the terminal shows the (masked) account that typed it and asks *Is this your account?*; only `y` keeps the pairing. Anything else, or no answer, disconnects the computer again. Type the code only in your own panel, and do not show it on a shared screen. |
| Secrets are masked | Before any text leaves: `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, JWTs, private keys, credentials in URLs and similar are replaced with `***` (and the card becomes incomplete). A value that contains shell syntax (`$(`, backticks, `;`, `|`, `&`, `<`, `>`) is never hidden: it may be the part that runs. Best effort, not a guarantee. |
| Instructions are plain text | Every instruction is cleaned (no control or invisible characters) and every line that starts with `/ ! # @ $` gets a zero-width space in front, so it can never become a slash command, bash mode, a memory note or an OpenClaw `/approve` (see below). |
| Local port | Listens on `127.0.0.1` only, random port. The key in `~/.hinty-agents/daemon.json` (readable by you only) **never travels**: every request from a hook, the mod, the CLI or the Hermes plugin is signed with it (HMAC-SHA256 over a one-time nonce, a timestamp, method, path and the body's SHA-256; 30 s window, a nonce counts once), and every answer is signed over the request's nonce, the status and the body. A process that grabbed a stale port after a crash or reboot learns nothing and cannot answer for the service; a stale `daemon.json` is removed when the service starts. Requests with an `Origin`, `Sec-Fetch-*` or foreign `Host` header (browsers) are refused. Protocol version 2 (`pv` in `daemon.json`): hooks, mod and service of different versions stay silent (no answer = the agent asks as usual); `doctor` tells you what to update. |
| No programs from the current folder | On Windows, programs (`claude`, `npm`, `codex`, `openclaw`, `hermes`, `icacls`, `taskkill`) are found by the bridge's own `PATH` lookup (never the current folder) and started without a shell, with `NoDefaultCurrentDirectoryInExePath=1`. `stop` kills a process only after checking it is this service. `HINTY_AGENTS_HOME` counts only as an absolute path, and the hooks start the service only from an installed hinty-agents outside the session's project folder. |
| The relay keeps no content | The Hinty server holds cards and session status in memory only (minutes); the database stores only a hash of this computer's token. Content crosses the server in transit (TLS). |

Logs (`~/.hinty-agents/daemon.log`) hold identifiers and counts only, never commands or answers, one event per line.
The Claude Code mod writes an instruction's id and length (not its text) to Claude Code's own debug log.

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
npx hinty-agents away on      # or in the panel, if you allowed remote switch-on
npx hinty-agents away off     # back at the desk (the panel and the glasses can always switch it off)
```

## Commands

| Command | |
|---|---|
| `npx hinty-agents` | set up (options: `--no-install`, `--no-start`, `--label <name>`) |
| `status` | service, link, away mode, sessions |
| `away on\|off` | away-from-desk mode |
| `remote-away on\|off` | allow (or not) the Hinty panel / glasses to switch away mode ON (default off; off always works) |
| `install <claude\|codex\|grok\|openclaw\|hermes>` / `uninstall <...>` | add or remove an agent's integration (`install grok --ask-shell`: see Grok Build; `install openclaw --token-file <file>`: see OpenClaw) |
| `doctor` | checks Node, Claude Code, the plugin (`claude plugin validate`), the service, the link, the hook and whether the mod reports in |
| `unpair` | disconnect this computer from your account and delete the token |
| `voice install` / `status` / `remove` | local speech to text for dictation from the glasses (see Voice) |
| `start` / `stop` | start or stop the background service (`stop` also keeps it from starting with the next session) |

After a reboot the SessionStart hook starts the service again (unless you ran `stop`).

Environment: `HINTY_AGENTS_API` (server for a new pairing, default `https://api.v1.hinty.eu`; another server is
announced with a warning, plain `http` only to this computer), `HINTY_AGENTS_HOME` (data folder, default
`~/.hinty-agents`; an absolute path, a relative one is ignored).

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
- a card appears for each shell command that is not on the harmless list (`ls`, `pwd`, `cat`, `git status|diff|log`, ...).
  Only ONE plain command is ever harmless: any chaining (`&`, `;`, `|`), redirection, `$`, backticks, quotes, options that
  write or run something (`--output=`, `-o`, `--ext-diff`...) and `cat`/`head`/`tail` paths outside the project (absolute,
  `..`, `~`) always get a card. `npm test` is not on the list (it runs a script the agent can edit). Own list:
  `"grok": {"except": [...]}` in `~/.hinty-agents/config.json`;
- **Deny** vetoes the step. **Allow** only means "no veto": Grok's own permission prompt still applies;
- if nobody answers within 280 s, the service is down, away mode is off or anything fails, the step runs (as Grok does with
  any failing hook). Do not use this as a security boundary; Grok's own `deny` rules and sandbox are the guarantee.

Without `--ask-shell` only the passive hooks are installed. Grok ignores the output of those, so there is no glasses line
and **instructions from the glasses are not supported** for Grok sessions.

## OpenClaw

`npx hinty-agents install openclaw` pairs the bridge once with your **local** OpenClaw Gateway (the first connection from
the loopback pairs itself; a remote Gateway needs `openclaw devices approve <requestId>`). It reads the Gateway port and
token from your `openclaw.json` (or `OPENCLAW_GATEWAY_TOKEN`) for that one connection only and does not store the shared
token; if the token is a secret reference (`file` / `exec`) give it once with `--token-file <file>`. **Nothing in your
OpenClaw configuration is changed.** Works with OpenClaw 2026.3.x (protocol 3) and is written for 2026.11 (protocol 4,
negotiated; not yet tried on a live 2026.11).

- **Approvals.** Every exec (and plugin) approval request becomes a card on the glasses / panel; **Allow** sends
  `allow-once`, **Deny** sends `deny`. `allow-always` is never sent. No answer sends nothing: OpenClaw then applies its own
  `askFallback` (default: deny) or another window of yours answers. An answer from another window (Control UI, TUI,
  `/approve`) closes the card at once.
- **The bridge is an OpenClaw client only while away mode is on** (and the link to Hinty is up). The mere presence of an
  approvals client changes OpenClaw's behaviour (a request waits until it times out instead of ending at once), so at the
  desk the bridge is not connected at all.
- **Sessions and messages.** Up to 8 recently active sessions show on the glasses (label = the agent, plus the channel for
  non-web sessions, e.g. `publisher·telegram`), with the `👓` line of the last answer. A message from the glasses is sent
  with `chat.send` as plain text (see "Instructions are plain text"; for OpenClaw `/` and `!` are also neutralised after
  white space, because OpenClaw runs `/approve ... allow-always`, `/exec security=full` and `! cmd` from chat text).
- **Token.** The device token is stored in `~/.hinty-agents/openclaw/` (owner only). It has the `operator.write` scope, so it
  can message your sessions: it never goes to the Hinty server or to a log. Revoke it with `openclaw devices remove <id>`
  (`uninstall openclaw` prints the command and deletes the local files).
- **Warning: `askFallback: full`.** If your OpenClaw is set to `askFallback: full`, OpenClaw itself allows a step when
  nobody answers in time, and the bridge cannot change that. `doctor` and `install` warn when they see it in
  `exec-approvals.json`; set it to `deny` to keep "no answer = no".

## Hermes Agent

`npx hinty-agents install hermes` (needs Hermes 0.21.5 or newer) copies a small plugin (Python, standard library only,
`hermes-plugin/hinty-agents`) into `<HERMES_HOME>/plugins/hinty-agents` and sets, with `hermes config set`:

```
security.approval.transport_fallback = builtin        (set first)
security.approval.transport          = hinty
plugins.entries.hinty-agents.allow_gateway_injection = true
```

and enables the plugin. It remembers what you had; **`uninstall hermes` puts the earlier values back** (or Hermes's
defaults) and never leaves `transport: hinty` with `fallback: deny` behind. Restart the Hermes gateway / open sessions
afterwards (plugins load once per process).

- **Approvals.** While away mode is on, each approval prompt (CLI, TUI, Desktop, messengers) is shown on the glasses /
  panel through Hermes's approval transport; Allow = `once`, Deny = `deny`. `session` and `always` are never returned.
- **No answer = Hermes asks as usual (N1).** Away mode off, the bridge not running, no answer in time or any error makes
  the plugin raise, and `transport_fallback: builtin` makes Hermes show its normal prompt. **Trade-off:** while away mode
  is on, the terminal prompt appears only after that wait (about 7 seconds before Hermes's own approval timeout, 5 minutes
  by default), so switch away mode off when you sit down. `doctor` checks that the fallback is `builtin`.
- **Sessions and messages.** Session state and the last answer come from Hermes hooks; a message from the glasses reaches
  the session through `ctx.inject_message` as a plain user message (a leading `/` or `!` is neutralised, and the plugin
  refuses anything that still looks like a command). Messages need the plugin's polling thread, so they work while
  Hermes runs. The plugin cannot always tell which of several simultaneous sessions asked: with exactly one running
  session it is exact, otherwise the card is labelled by Hermes's session key.
- **Needs Python 3.14 as Hermes's own interpreter** (Hermes builds an isolated 3.14 environment for plugins); the plugin itself
  is plain standard-library Python.
- Verified: install / uninstall with the real `hermes` CLI (settings restored), the real plugin loader registering the
  `hinty` transport, a live Hermes session calling the transport and falling back to its normal prompt when the bridge says
  no (away mode off), and the allow / deny / failure handling through Hermes's own `invoke_approval_transport`. Not verified
  on a live session: an answer from the glasses in a running TUI, and `ctx.inject_message`.

## Instructions are plain text

Whatever you send from the glasses or the panel reaches the agent as an ordinary message, never as a command: Claude Code
treats a leading `!` as bash mode (no permission), `/` as a slash command and `#` as a memory note, and OpenClaw runs a
chat line `/approve <id> allow-always` as an approval (checked on a live OpenClaw). The service puts a zero-width space in front of every line that,
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

## Voice (dictate to your agents from the glasses)

Local speech to text, free, no cloud API. Say an instruction in the glasses' dictation view; the text comes back to the
glasses, you choose Send / Edit / Add / Cancel, and only Send reaches the agent.

\sherpa-onnx-node 2.0.2: already installed
  silero_vad.onnx: already there
  encoder.int8.onnx: already there
  decoder.int8.onnx: already there
  joiner.int8.onnx: already there
  tokens.txt: already there
trial load of the model ...
voice is ready (model parakeet-v3)
Voice (local speech to text)
Ready:    yes (model parakeet-v3)
Engine:   sherpa-onnx-node 2.0.2 (23 MB on disk)
  parakeet-v3    installed  640 MB on disk
  whisper-small  installed  358 MB on disk
  whisper-turbo  installed  989 MB on disk
  silero-vad     installed  0.6 MB on disk
✓ Voice removed (2009 MB freed).
- **Engine:**  2.0.2 (Apache 2.0), installed on demand into , never added to this
  package's dependencies. Models go to , each file is checked against a pinned size and SHA-256
  and written atomically. A running service says  again with  right after the install.
- **Models:**  (default; NVIDIA Parakeet TDT 0.6b v3 int8, 25 European languages incl. Polish, CC BY 4.0, ~640 MB,
  ~1 GB RAM while in use),  (358 MB) and  (989 MB, slow on CPU) via
  . Silero VAD (0.6 MB) splits speech into stretches that are recognized while you are still talking.
  The model loads when dictation starts and is released after 10 idle minutes.
- **Developer words:** the default model is biased towards ~130 words like commit, rebase, README, endpoint, package.json
  (). Add your own, one per line ( sets a score), in .
   turns the bias off.
- **Privacy:** audio exists only in memory while one utterance is recognized (at most 35 s, one at a time) and is dropped
  afterwards; nothing is written to disk and logs hold counts only. Recognition runs on this computer. With away mode
  off the bridge reads nothing: it only answers . Only the recognized text goes back to your own glasses screen.
- **Accuracy:** measured in . English commands are near perfect; Polish sentences with English
  jargon often need a fix in the preview step.

## Uninstall

```bash
npx hinty-agents uninstall claude   # removes the plugin and the marketplace entry
npx hinty-agents uninstall openclaw # deletes the device key and token (then: openclaw devices remove <id>)
npx hinty-agents uninstall hermes   # restores your Hermes settings and removes the plugin
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
JSDoc types (no build step); the only dependency is `socket.io-client` (speech models and `sherpa-onnx-node` are installed on demand by `voice install`) (the speech engine and models are installed on demand by `voice install`). The mod's types come from Claude Code: once
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
