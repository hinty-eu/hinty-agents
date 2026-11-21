// The Node.js the desktop app bundles: one LTS version for every system, each archive pinned by its sha256 from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt (copied here when the version is changed, so a changed download is
// refused even if the SHASUMS file it came with was changed too).
//
// Why a separate Node.js and not Electron's own (ELECTRON_RUN_AS_NODE): the agents start our hooks by a command line
// (Codex and Grok through a shell, Claude Code in exec form) that cannot carry an environment variable, so the Electron
// binary would open a second window at every hook; npm (needed for the voice engine) is not part of Electron; and with
// a real Node.js the app can switch off Electron's RunAsNode fuse, so the signed app is never a general Node.js runner.

export const NODE_VERSION = '26.13.1'

/** @type {Record<string, { file: string, sha256: string }>} key: `${platform}-${arch}` */
export const NODE_FILES = {
  'win32-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, sha256: 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7' },
  'win32-arm64': { file: `node-v${NODE_VERSION}-win-arm64.zip`, sha256: '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97' },
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: '82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f' },
}

export const nodeUrl = (/** @type {string} */ file) => `https://nodejs.org/dist/v${NODE_VERSION}/${file}`
