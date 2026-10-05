# Upstream merge status — post-v0.3.1 (2026-10-06)

**Status:** COMPLETED  
**Merge commit:** `3c11b97` (`Merge upstream master (post-v0.3.1) into fork`)  
**Date:** 2026-10-06  
**Remote:** `upstream` → `https://github.com/multizenteam/multizen-browser.git`  
**Branch merged:** `upstream/master` into local `master`  
**Upstream tip:** `b0bc604` (`fix(mcp): keep an explicit CAPTCHA/2FA defer guardrail`)  
**Upstream release tag:** none newer than `v0.3.1` — tip is `v0.3.1` + 19 commits  
**Fork tip before merge:** `bc83f01` (`release: v0.8.0 (#14)`)  
**Divergence at start:** fork **22** commits ahead / **6** commits behind upstream (merge-base `306d9bb`, prior sync in `cd24cd1`)  
**Fork release:** `0.8.1`

## Decisions

| # | Topic | Choice | Outcome |
| --- | --- | --- | --- |
| 1 | App / desktop version | Fork semver | **0.8.1** (patch) — upstream changes are proxy UX polish and MCP guidance text |
| 2 | MCP raw CDP / timezone | Unchanged | Upstream only touched `MULTIZEN_MCP_INSTRUCTIONS`; fork always-on `cdp_send` / `cdp_send_no_safety` and strict-pin timezone untouched |

## Upstream commits pulled

From `306d9bb` → `b0bc604`:

- `ea2bfdc`, `3002ee2` — proxy tester shows **human-readable errors** (bad credentials, wrong HTTP/SOCKS type, refused, reset, DNS, unreachable, timeout) instead of raw TLS/socket strings, plus **round-trip latency** with green/amber/red coloring
- `38f9cb3` — proxy paste accepts `user:pass:host:port` (reversed colons), `host:port##user:pass`, and `host,port,user,pass`
- `0271943`, `b0bc604` — MCP `initialize` guidance: agents keep working autonomously on authorized tasks instead of handing off to a human, but must still stop on CAPTCHA / 2FA and let the user handle it; anti-bulk-farming constraint kept
- `429d66e` — updated profiles-list screenshot in the README assets

## Conflicts

None. `packages/mcp-server/src/server.ts` auto-merged (only the instructions block changed upstream). Fork made no edits to `proxyGeo.ts`, `parseProxy.ts`, or `ProxyTester.tsx` since the last sync.

## Verification

| Check | Result |
| --- | --- |
| `yarn typecheck` (all workspaces) | pass |
| `yarn workspace @multizen/mcp-server test` | 27/27 pass |
| `yarn test:fingerprint`, `test:fingerprint-entropy`, `check:chrome-version` | pass |
| `yarn test:launch-timezone` | 6/6 pass |
| `yarn smoke:fingerprint-seed` | offline checks pass (live part skipped, no running app) |
| `packages/mcp-server/scripts/test-cdp.ts` (not in CI) | new upstream `initialize` guidance test passes; 37 older failures are upstream raw-CDP gating / deny-list tests the fork declined in the v0.3.0 merge (decision #1 there) — unchanged by this merge |

## Local environment note

The checkout had moved from `Desktop/` to `Documents/Repositories/`, leaving the per-workspace `node_modules/@multizen/*` symlinks pointing at the old path (typecheck failed with `Cannot find module '@multizen/types'`). Fixed by deleting the stale links and re-running `yarn install --immutable`. No tracked files changed.
