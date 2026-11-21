# Changelog

## 0.4.0

Desktop app for people who do not use a terminal (`desktop/`, README "Desktop app (Windows, macOS)").

- **Hinty Agents app** (Electron): a window and a tray icon, 10 languages. Pairing with the code and the 4-digit check,
  away mode, the remote switch-on consent as its own checkbox (off by default, risk next to it), connect / disconnect
  each agent, voice install with a progress bar, "Remove everything", start at sign-in in the background. Windows: a
  one-click NSIS installer per user, no administrator rights. macOS: a signed, notarized DMG per processor, built from the
  tag in a private build repository (the Apple secrets never come into this public one);
  `.github/workflows/desktop-mac.yml` is an unsigned build check.
- **Node.js inside**: the official LTS build (26.13.1, sha256 of each archive pinned in
  `desktop/scripts/node-runtime.mjs`), not Electron's binary in run-as-node mode: the agents start hooks by a command line
  that cannot carry an environment variable, npm is needed for the voice engine, and Electron's RunAsNode,
  NODE_OPTIONS and --inspect fuses stay off.
- `hinty-agents desktop`: the app's worker (`src/desktop.js`), requests over an IPC channel only. Every button is one of
  the CLI's own commands (their lines collected) or a read of the state; nothing in the security model changes.
- Pairing is one shared function (`pairComputer` in `src/cli.js`) for the wizard and the app: no check number =
  refused, 3 tries, any refusal unpairs at the server and saves nothing. `pair()` takes an AbortSignal (Cancel).
- The program copy's Claude Code `hooks.json` names the running Node.js by its full path when that Node.js is not the
  `node` on PATH (the bundled one); otherwise it keeps `node` as before. A copy made for another runtime is made again,
  the manifest covers the changed file. `doctor` checks that the hooks' Node.js exists.
- `stop --for-update` (the app's uninstaller before an update): stops the service without marking it stopped.
- `voice install` reports byte progress over the VAD and the model (`progress` callback) for the app's progress bar.

## 0.3.2

Small fixes after the fourth review.

- `uninstall --purge`: the `.hinty-agents-home` marker is written only when the data folder did not exist or was empty
  at its first use, and it now lists the top-level entries hinty-agents created. A `HINTY_AGENTS_HOME` that points to a
  folder with other things gets a warning and no marker. Purge removes only listed entries and, inside a sub-folder, only
  our own files (voice models by name, size and SHA-256 of the registry, our partial downloads, our three hook scripts,
  our OpenClaw and Hermes files, the voice package); the folder goes only when we created it and it is empty. In `app/`
  `.tmp-*`, `.old-*` and `.manifests` are removed only in the shape we make them, and old versions only with our
  `package.json`. Program copies are no longer removed when the data folder is protected.
- `HINTY_AGENTS_HOME` with a part that ends in a space, a tab or a dot is ignored with a warning (service and hooks),
  because Windows tools treat it as another folder.
- OpenClaw: the copy of OpenClaw's message clean-up runs in one pass (same result, checked against the original
  expressions on 200 000 random texts); a message of 8000 characters takes a few milliseconds instead of 0.4 s.
- README: the manifest of the program copy checks consistency, it is not a firewall.

## 0.3.1

Security fixes after the third review.

- Cards: characters without a glyph are found by Unicode property, not a list (every default-ignorable, format,
  private-use and unassigned character, so also soft hyphens, variation selectors and tag characters), and a line with
  nothing visible on it (white space, combining marks, blank symbols such as U+1D159, U+16FE4 or U+FFFC) counts as
  empty. Any such removal or folding makes the card incomplete (deny only from the glasses). An emoji keeps its
  variation selector or joiner on the card, but the card is incomplete too; emoji without them, accents, Polish and
  other scripts change nothing.
- OpenClaw: the "current message" marker is broken with a visible character, and every message is checked with a copy
  of OpenClaw's clean-up before it is sent (a text built for the order of its steps gets every `/` and `!` neutralised),
  so the three layers no longer depend on each other. If the second pairing fails, the approvals device is kept
  (instructions stay off) instead of being left in the Gateway without a key; devices left over are named with
  `openclaw devices remove <id>` in install, `doctor` and uninstall.
- Codex and Grok hooks: Node.js is written with forward slashes (`C:/PROGRA~1/nodejs/node.exe` starts in `cmd.exe`,
  PowerShell and `sh`); `install` and `doctor` run the installed command with `--ping` (nothing read, nothing sent) in
  those shells and report where it does not start (for Grok with `--ask-shell` that would mean no veto).
- Hooks: a signature header with bytes outside ASCII no longer ends a hook with an exception; any error in a callback
  ends the hook quietly (no output, exit 0).
- Hermes: redaction markers of other spellings (`<redacted>`, `[hidden]`, `•••`, written-out `\u200b` ...) make the
  card incomplete too.
- `uninstall --all --purge` deletes only what hinty-agents created; the folder itself only when it carries the
  `.hinty-agents-home` marker and nothing else is left; a `HINTY_AGENTS_HOME` that is a home folder, a drive or a system
  folder is never emptied (nor has its access narrowed: `doctor` reports such a folder). From `app/` only version
  folders with our `package.json` are removed.
- `app/<version>` is used only while it matches the manifest (size and SHA-256 of every file) written when it was
  copied; otherwise it is copied again, and the service refuses to start from a copy that does not match.
- `hinty-agents daemon` exits with code 1 when it refuses to start.

## 0.3.0

- Security fixes after the second review: OpenClaw instructions go over a separate Gateway device without approval
  rights; a command Hermes redacted is an incomplete card (deny from the glasses only); hook commands start Node.js by
  its full path; blank padding on cards is folded; pairing asks for a 4-digit number shown in the panel.
- The program is copied to `~/.hinty-agents/app/<version>` and the service, hook files and the Claude Code plugin
  marketplace use that copy, not npm's cache (the previous version is kept, older ones are removed). A git checkout
  runs in place.
- Installing a newer version updates the Claude Code marketplace and plugin; `doctor` reports a missing program folder
  or plugin folder.
- `uninstall --all` removes every agent's hooks and plugins, unpairs, stops the service, deletes the program copy and
  (after asking) the data folder.
- Package ready for npm / `npx github:`: repository, homepage, keywords, `files`, SECURITY.md.

## 0.2.0

- Signed local protocol (HMAC over a one-time nonce, timestamp, method, path and body; signed answers) between hooks,
  the mod and the service; the key never travels.
- Remote switch-on of away mode needs your consent on the computer (`remote-away on|off`), lasts at most 12 hours.
- Cards that do not show everything that will run are marked incomplete and can only be denied.
- Adapters: Codex CLI, Grok Build, OpenClaw (Gateway client), Hermes Agent (plugin); safe plain-text instructions.
- Local voice input (speech to text on your computer) for dictating to agents from the glasses.

## 0.1.0

- First version: bridge for Claude Code (PermissionRequest and SessionStart hooks, mod for session status and
  instructions), pairing with the Hinty panel, away mode.
