# MultiZen

> **AI-native browser for agents and operators.** Desktop app + embedded MCP server. Patched Chromium with real anti-detect fingerprints. Local profiles, persistent state, full LLM-driven browser navigation through Cursor / Claude Desktop / any MCP client.

Marketing site: [getmultizen.com](https://getmultizen.com)
Discord: [discord.gg/pd6MhzPbJ3](https://discord.gg/pd6MhzPbJ3)

## Status

`v0.2.0-pre` — full rewrite in progress. The legacy v0.1.1 codebase (Electron + Vue 2 multi-session browser) is preserved on [`archive/vue-v1-legacy`](https://github.com/multizenteam/multizen-browser/tree/archive/vue-v1-legacy) and tag [`v0.1.1-legacy-final`](https://github.com/multizenteam/multizen-browser/releases/tag/v0.1.1-legacy-final).

## What's in this repo (open core)

```
apps/
  desktop/                 # Electron + React + Tailwind GUI
packages/
  mcp-server/              # MCP server exposing browser-drive tools
  profile-manager/         # SQLite profile CRUD + encrypted local storage
  types/                   # Shared TypeScript types
```

The advanced **fingerprint engine and Chromium patches** live in a separate private repo and ship as a binary dependency. This is open-core — if we open-sourced the fingerprint internals, detection services would patch them within a week.

## Stack

- Electron 33+
- React 19 + TypeScript (strict)
- Tailwind v4 + shadcn/ui
- @modelcontextprotocol/sdk for MCP server
- better-sqlite3 for local profile storage
- Yarn 4 workspaces
- electron-vite for dev/build

## Develop

```sh
yarn install
yarn dev            # launch desktop app
yarn mcp:dev        # MCP server in standalone mode
yarn typecheck
yarn build
```

Requires Node 20+.

## License

Open-core MIT for everything in this repo. Closed source for the fingerprint engine. See [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome on the open-core packages. For the fingerprint engine, behavior reports help — but we cannot accept code contributions to the closed parts.

See [getmultizen.com/acceptable-use](https://getmultizen.com/acceptable-use) for what we support and what we do not.
