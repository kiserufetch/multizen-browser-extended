# MultiZen v0.2 — public roadmap

This document tracks what's done and what's coming. Last updated: 2026-04-30.

## Done — repo scaffolding + working core

- [x] Monorepo split: `apps/desktop`, `packages/{mcp-server,profile-manager,cdp-driver,settings-store,types}`
- [x] Yarn 4 workspaces (node-modules linker for native module compat)
- [x] TypeScript strict across every package — clean typecheck
- [x] Profile manager with SQLite storage, fingerprint pool, full CRUD
- [x] **Encrypted profile archive (export/import)** — AES-256-GCM with scrypt KDF
- [x] MCP server with full tool surface (list/create/launch/close/navigate/click/type/extract/screenshot)
- [x] Mock browser driver for protocol testing without Chromium
- [x] **Standalone stdio MCP runner** — spawn from Cursor / Claude Desktop without GUI
- [x] **HTTP+SSE MCP transport** — external clients connect to running desktop app
- [x] **Real CDP integration** in `ChromiumBrowserDriver` via chrome-remote-interface:
      navigate / click (CSS selector) / type / extract (page snapshot) / screenshot
- [x] **No external API calls.** click and type take CSS selectors only; extract returns
      the trimmed accessibility tree. The calling MCP client (Claude in Cursor / Claude
      Desktop / etc.) does any natural-language reasoning on its own side.
- [x] **Settings store** for app preferences (MCP HTTP toggle)
- [x] **Activity log** — real-time stream of MCP tool calls forwarded to renderer
- [x] Electron 33 + React 19 + Tailwind v4 GUI:
      ProfileList, ProfileDetail (edit name/tags/proxy/fingerprint),
      ActivityPanel (real-time tool calls), SettingsSection (MCP HTTP toggle, About)

## Next — milestone v0.2 alpha

- [ ] Wire export/import IPC handler to use restored profile data dir (currently
      dataDir is regenerated; should preserve archive's path layout)
- [ ] License gate (free 3 profiles, Pro unlimited)
- [ ] Crypto-only checkout integration (NOWPayments hosted page) — needs API key
- [ ] Bundle Electron icon assets, write minimal `build/icons` set
- [ ] First closed alpha for 5–10 testers

## v0.2 beta

- [ ] Patched Chromium ships in production builds (closed binary from private repo)
- [ ] Code signing for macOS (Apple Dev Individual)
- [ ] Code signing for Windows (after entity setup)
- [ ] Auto-update via electron-updater + GitHub Releases
- [ ] Chrome extension loading per profile
- [ ] Cookie import from Chrome / Firefox profiles
- [ ] Public Show HN + Product Hunt launch
- [ ] Submission to MCP marketplaces (mcpservers.org, glama.ai, smithery.ai)

## v0.3 — team / cloud

- [ ] License server (closed)
- [ ] Encrypted cloud backup
- [ ] Multi-device sync
- [ ] Team workspaces, shared profiles
- [ ] RBAC roles
- [ ] Activity audit log

## Validation gates

We will halt scope expansion at each gate if metrics are red:

- **Gate 1 (Week 4):** 500+ unique landing visits, 3%+ signup conversion, 1+ pre-order
- **Gate 2 (Week 12):** 30%+ activation, 25%+ Day-7 retention from closed alpha
- **Gate 3 (Month 6):** 1.5%+ free→paid conversion, 50+ donations, $1K+ MRR
- **Gate 4 (Month 12):** $2K+ MRR or pivot decision

If any gate fails, we revisit positioning or pivot before pouring more time in.
