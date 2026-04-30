# MultiZen v0.2 — public roadmap

This document tracks what's done and what's coming. Last updated: 2026-04-30.

## Done — repo scaffolding

- [x] Monorepo split: `apps/desktop`, `packages/mcp-server`, `packages/profile-manager`, `packages/types`
- [x] Yarn 4 workspaces, TypeScript strict, prettier, .gitignore
- [x] Profile manager with SQLite storage, fingerprint pool, CRUD API
- [x] MCP server with full tool surface (list/create/launch/close/navigate/click/type/extract/screenshot)
- [x] Mock browser driver for protocol testing without Chromium
- [x] Standalone MCP server runner (stdio for spawned MCP clients)
- [x] Electron skeleton: main process, preload bridge, React renderer, basic GUI
- [x] ChromiumBrowserDriver scaffold (process spawn, profile data dirs)

## Next — milestone v0.2 alpha

- [ ] Wire MCP server into desktop main process via HTTP+SSE on localhost:7777
- [ ] Real CDP integration in `ChromiumBrowserDriver`: navigate, click, extract, screenshot
- [ ] Bundle a Chromium binary for dev (system Chrome fallback for now)
- [ ] Profile detail page in GUI: edit name, tags, proxy, fingerprint
- [ ] Activity log panel (what AI agents are doing in real-time)
- [ ] Profile import/export as encrypted archive
- [ ] License gate (free 3 profiles, Pro unlimited)
- [ ] Crypto-only checkout integration (NOWPayments hosted page)
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
