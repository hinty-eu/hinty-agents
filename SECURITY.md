# Security policy

hinty-agents approves commands on your computer, so security reports matter.

## Reporting a vulnerability

Please report it privately by e-mail to **support@hinty.eu** (subject: "hinty-agents security"). Do not open a public
issue for a vulnerability. Include the version (`npx hinty-agents --version`), your system, and the steps to reproduce.

You get an answer within a few working days. We fix confirmed problems in a new release and say so in
[CHANGELOG.md](CHANGELOG.md); we credit you there if you want. There is no bug bounty.

## What is in scope

The code in this repository: the local service, the hooks and plugins for each agent, the pairing and the local
protocol. The security model (who can do what, and what the bridge can never do) is described in the README under
"Security". The Hinty server and web panel are separate; report problems there to the same address.

## Supported versions

Only the latest release gets fixes. Pin the version you install (`npx hinty-agents@<version>`) and update on purpose.
