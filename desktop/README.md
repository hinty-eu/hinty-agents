# Hinty Agents desktop app

An installer for people who do not use a terminal: a small window and an icon next to the clock over the `hinty-agents`
bridge in the parent folder, with its own Node.js inside. What it does and why it does not change the security model:
the main [README](../README.md#desktop-app-windows-macos).

```
desktop/
  main.cjs            Electron main process: window, tray, login item, the bridge worker on the bundled Node.js
  preload.cjs         the window's only API (a fixed list of calls)
  ui/                 the window: index.html, app.js, style.css, i18n.js (10 languages), img/ (icons)
  scripts/stage.mjs   puts the bridge and the pinned Node.js into build/ (not in git)
  scripts/node-runtime.mjs   the Node.js version and the sha256 of each archive
  scripts/icons.mjs   draws ui/img/*.png (plain Node, no image tool)
  build-resources/    installer icon, NSIS macro (uninstall / update), macOS entitlements
  electron-builder.yml
```

## Build

Once, in the repository root: `npm ci` (the bridge's one dependency, `socket.io-client`). Then in `desktop/`:

```bash
npm ci
npm run dir            # stage + unpacked app in dist/win-unpacked (or dist/mac*) for a quick look
npm run dist:win       # Windows installer: dist/Hinty-Agents-Setup-<version>.exe
npm run dist:mac:arm64 # macOS DMG for Apple silicon (on a Mac; signing and notarization need the env under Signing)
npm run dist:mac:x64   # macOS DMG for Intel
```

`stage` copies the bridge with its own `copyPackage` (the files a program copy gets) to `build/bridge`, downloads the
Node.js archive for the target (`--platform win32|darwin --arch x64|arm64`) from nodejs.org into `.cache/`, refuses it
unless its sha256 matches `node-runtime.mjs`, and keeps the binary, npm (the voice engine is installed with it) and the
licence in `build/node`. The version of `desktop/package.json` must equal the bridge's.

Run from source without packaging: `npm start` (stage + `electron .`). If your terminal sets `ELECTRON_RUN_AS_NODE`
(VS Code does), unset it first. A dev run never registers a login item.

Changing the Node.js version: edit `NODE_VERSION` and copy the four sha256 values from
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`. Keep it an LTS line, the same on both systems.

## Signing

- **macOS**: signed and notarized in a private build repository, from a tag of this one (this public repository holds
  no Apple secret). There electron-builder gets the "Developer ID Application" certificate (`CSC_LINK`,
  `CSC_KEY_PASSWORD`) and notarizes the app with an App Store Connect API key (`APPLE_API_KEY` = path of the `.p8`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); the DMG is signed (`-c.dmg.sign=true`), notarized with `notarytool` and
  stapled. The bundled `node` is signed with the same identity and the hardened runtime (entitlements: JIT for V8,
  library validation off for the voice engine npm installs later). `.github/workflows/desktop-mac.yml` here is an
  unsigned build check (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `-c.mac.notarize=false`).
- **Windows**: not signed yet (SmartScreen: "unknown publisher"). With a certificate: `CSC_LINK` / `CSC_KEY_PASSWORD`,
  or Azure Trusted Signing (`win.azureSignOptions` in `electron-builder.yml`). Sign `resources/node/node.exe` too
  (`win.signExts` or a sign hook), since the agents start it.

## Test

`testy-e2e/agenci/desktop/e2e-desktop.js` in the Hinty monorepo drives the unpacked app over CDP with a PATH without
Node.js and isolated profile folders: pairing (wrong and right 4 digits), Connect Claude Code (real `claude`), away mode,
a `claude -p` permission prompt approved by a fake panel (the hook and the service run on the bundled `node.exe`), the
remote switch-on consent, "Remove everything", screenshots in English and Polish.

Flags for tests only: `HINTY_DESKTOP_USER_DATA=<folder>` (Electron's data folder), `HINTY_DESKTOP_NO_LOGIN_ITEM=1` (no
sign-in entry is written), and Chromium's `--remote-debugging-port`.
