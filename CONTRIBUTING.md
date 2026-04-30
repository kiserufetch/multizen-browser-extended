# Contributing to MultiZen

MultiZen is open-core. The desktop app shell, MCP server, and profile manager are MIT-licensed and live in this repo. The advanced fingerprint engine and Chromium patches live in a private repo and ship as a binary dependency — we cannot accept code contributions to those parts.

## What we welcome

- Bug reports, especially with reproduction steps
- UX/GUI improvements in `apps/desktop/src/renderer`
- Additional MCP tools in `packages/mcp-server`
- Profile manager features (import/export, encrypted backup, tagging)
- Documentation improvements
- Tests

## What we cannot accept

- Reverse-engineered fingerprint patches
- Anything that would let detection vendors trivially counter our anti-detect
- Code that increases attack surface for credential / cookie exfiltration
- Pull requests violating our [acceptable use policy](https://getmultizen.com/acceptable-use)

## Setup

```sh
yarn install
yarn dev            # desktop app
yarn typecheck
```

Requires Node 20+, Yarn 4.

## Pull requests

1. Fork and branch from `master`
2. Keep PRs small and focused
3. Run `yarn typecheck` before pushing
4. Reference any related issue
5. Add a one-paragraph description of what changed and why

## Discussion

Use [GitHub Issues](https://github.com/multizenteam/multizen-browser/issues) for bugs and feature requests. Use [Discord](https://discord.gg/pd6MhzPbJ3) for general questions, design discussion, and showing off your workflows.

## Code of conduct

Be respectful, technical, specific. Disagreement is fine — personal attacks are not.
