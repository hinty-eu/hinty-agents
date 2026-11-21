# Changelog

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
