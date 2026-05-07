# Monetization, open-core split, and cloud-sync architecture

Canonical answer to "what's free, what's paid, how does it work, and where does the code live?". Last updated: 2026-05-02.

## Tier matrix

| | **Anonymous** | **Free** | **Pro** | **Team** | **Enterprise** |
|---|:-:|:-:|:-:|:-:|:-:|
| **Price** | $0, no signup | $0, account | **$19/mo** · $99/yr · **$49 lifetime** during EA | **$99/mo** + $25/extra seat | Contact |
| **Profiles** | 1 | 3 | 10 | 100 | unlimited |
| **Patched Chromium** (Canvas / WebGL / Audio / JA3-JA4) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **E2E encrypted cloud sync** | — local only | ✓ capped 300 MB | ✓ 5 GB | ✓ 50 GB | custom |
| **Multi-device sync** | — | ✓ | ✓ | ✓ | ✓ |
| Seats | 1 | 1 | 1 | 3 + $25/seat | custom |
| Shared workspace | — | — | — | ✓ | ✓ |
| Profile lock (one device at a time) | — | — | — | ✓ | ✓ |
| Audit log | — | — | 7-day basic | 90-day full + CSV | full + retention |
| Roles (owner / admin / member) | — | — | — | ✓ | ✓ + SSO |
| MCP API rate limit | 30 rpm | 30 rpm | 60 rpm | 300 rpm | custom |
| Chromium milestone update lag | up to 7 days | up to 7 days | < 24h | < 24h | < 24h |
| Support | community | community | email | email + SLA | dedicated |
| Phone home | **never** | only on login + sync | login + sync | login + sync | + audit upload |

## Why these specific numbers

- **Anonymous tier with 1 profile is unique in the market.** Every competitor (GoLogin, AdsPower, Multilogin, Dolphin Anty, Browserbase) requires signup before the user gets any value. We don't. Run the .dmg, get a working anti-detect browser in 30 seconds, no email asked. That zero-friction path is our distribution differentiator.
- **Free tier with 3 profiles and capped cloud sync** matches GoLogin Free on profile count, beats it on cloud-multi-device. Critical: the cloud belongs to Free so the upgrade path (Free → Pro) doesn't lose data when the user installs on a second machine.
- **Patched Chromium is base, not paywall.** Anti-detect is the product, not an upsell. Every tier — even Anonymous — gets the patched Chromium binary with native fingerprint patches. Differentiation moves to *capacity*, *collaboration*, and *update freshness*.
- **Pro tier with 10 profiles at $19/mo** is the indie sweet spot. Solo researcher, indie crypto operator, single sales rep — they pay $19 without thinking. The $49 lifetime during early access is the bootstrap funding mechanism, capped at first 100 buyers.
- **Team tier with 100 profiles at $99/mo** matches the agency / sales-engineering segment. Multilogin sells the same headcount at €79 (≈$85). Dolphin Anty Base is $89 with $10/extra seat. We sit in the same band with cleaner per-seat pricing.
- **Enterprise** is open white-space; not a priority for year 1.

## What exactly does Pro/Team buy if Chromium is base?

| Pro buys | Team buys (everything in Pro plus) |
|---|---|
| 10 profiles vs 3 | 100 profiles vs 10 |
| 5 GB cloud vs 300 MB | 50 GB cloud |
| 60 MCP rpm vs 30 | 300 MCP rpm |
| Same-day Chromium milestone updates | Same |
| Email support, response in 24h | SLA, response in 4h |
| 7-day Activity log | 90-day Activity log + CSV export |
| — | Shared workspace + profile lock |
| — | RBAC roles |
| 1 user, multi-device | 3 seats included, +$25/seat |

## Why account-first instead of license keys (decided 2026-05-02)

Earlier draft used a license-key model. Reversed. Subscription state queried from the backend on login is the single source of truth.

Reasons:
- **Industry standard in 2026** — Linear, Cursor, Notion, every anti-detect competitor.
- **One auth/billing system instead of two parallel ones.** No "did I lose my key or my password?" support load.
- **Clean refund / upgrade / downgrade.** Change a row, client polls `/me`, reflects.
- **Onboarding for paying users is "click magic link → working"**, not "copy key from email and paste into app".

The one exception: Anonymous tier never logs in. The moment a user wants more than 1 profile or any cloud feature, they sign up.

## Account flow

```
1. Install MultiZen → Anonymous mode
   - 1 profile, no account, no phone home
   - All MCP tools work
   - Patched Chromium downloaded on first run (see "Chromium bootstrap" below)

2. Hit profile limit OR want cloud → "Sign up free for 3 profiles + multi-device"
   - Google OAuth or email magic link (Resend SMTP)
   - Backend (Supabase Auth) creates user
   - Anonymous profile migrates to owned-by-user (data stays local)
   - User opts into cloud sync → encrypted blobs upload (300 MB cap)
   - GET /me returns { tier: "free", profileLimit: 3, storageMB: 300, entitlements: { cloudSync } }

3. Want more profiles / more cloud / faster Chromium updates → "Upgrade to Pro"
   - Pay via NOWPayments (USDT/BTC) or LemonSqueezy (cards, post-Чили SpA)
   - Webhook updates subscription on backend
   - Next /me poll returns { tier: "pro", profileLimit: 10, storageMB: 5000, ... }

4. Want teammates → "Upgrade to Team"
   - Stripe / LemonSqueezy subscription change
   - Backend creates workspace, sends invite emails
   - Team members magic-link in → join workspace
```

### Offline grace period

Subscription state cached locally with `lastVerifiedAt`. **30-day grace period offline.** After 30 days without a successful `/me` call, the app non-blockingly downgrades to Free behavior with a "Reconnect to continue with Pro" notice. Profile data stays accessible.

## Chromium bootstrap

The patched Chromium binary is ~150 MB. Bundling it inside the installer would balloon downloads to ~200 MB and ship the same binary platform-wide, which makes auto-update friction larger and complicates code-signing.

**Decision: bootstrap-download on first run.**

### How it works

1. App boots. Main process checks `~/Library/Application Support/MultiZen/chromium/<version>/` (Mac) or `%APPDATA%/MultiZen/chromium/<version>/` (Win).
2. If present + SHA256 matches manifest → use it.
3. If missing or hash mismatch → render `<ChromiumBootstrap />` modal in renderer. Fetch manifest from `https://updates.getmultizen.com/chromium/<platform>-<arch>.json` → contains URL + SHA256 + version.
4. Stream-download from R2 bucket with progress (in-app progress bar). Resumable via Range requests.
5. Verify SHA256 on disk. Extract (Mac: dmg → app bundle; Win/Linux: tarball).
6. Update local manifest. Hide bootstrap modal. App becomes usable.

In **dev**, skip the bootstrap entirely and use system Chrome (`/Applications/Google Chrome.app` on Mac). This is what already happens today.

### Subsequent updates

`update-server` exposes a `/chromium/manifest` endpoint with the latest version per channel (`stable` / `beta`). Pro/Team users poll on app start with no debounce. Free/Anonymous users are debounced to weekly polls (this is the "update lag" differentiator). When a newer version is found, download in background and swap on next profile launch.

### Cost projection

CDN egress at 10K active users:
- 10K × 150 MB initial = 1.5 TB on first install
- Cloudflare R2: $9/TB egress = ~$15
- Plus monthly delta updates for Pro/Team (~30 MB/month × 1K Pro users = 30 GB) = $0.30
- Free users get full re-download every milestone bump (worst case 600 GB/mo) = $5

Total: ~$20-30/mo for Chromium distribution at 10K users. Trivially manageable.

## Backend stack — self-hosted Docker on a VPS

We do not use Supabase, Auth0, Clerk, or any other managed-auth SaaS. Our audience is technical operators and AI devs who'd notice and care about vendor lock-in. Self-hosting is a feature.

### Stack

| Component | Choice | Why |
|---|---|---|
| Compute | Hetzner Cloud CPX21 (€8/mo, 3 vCPU / 4 GB) or DigitalOcean equivalent | Predictable cost, EU jurisdiction, no surprise scaling bills |
| OS | Debian 12 | Stable, well-known |
| Orchestration | Docker Compose | One file, no Kubernetes complexity for solo founder |
| Reverse proxy | Caddy | Auto-TLS via Let's Encrypt, zero config |
| Database | Postgres 16 (Docker) | Industry standard, our team knows it |
| Cache / sessions | Redis 7 (Docker) | Session + rate-limit storage |
| API | Bun + Hono | Fast, TypeScript end-to-end, our stack |
| Auth library | [Better-Auth](https://better-auth.com) (TypeScript) | Self-hosted, drop-in, supports Google OAuth + magic links + sessions out of the box |
| Email | Resend transactional API ($20/mo Pro) | Magic-link delivery — self-hosted SMTP gets blackholed |
| Object storage | Cloudflare R2 ($9/TB egress, $0.015/GB stored) | E2E encrypted profile blobs; we never see plaintext |

### Cost at launch and at scale

| Stage | VPS | Email | R2 | Total |
|---|---|---|---|---|
| Launch (10 paying users) | €8/mo | $0 (Resend free tier 3K emails) | $0 (~5 GB stored) | **~€8/mo** |
| 100 paying users | €8/mo | $0 | ~$2/mo (200 GB) | **~€10/mo** |
| 1000 paying users | €25/mo (CPX31, 8 GB RAM) | $20/mo Resend Pro | ~$30/mo (1.5 TB) | **~€75/mo** |
| 10K paying users | €100/mo (dedicated AX42) | $80/mo Resend | ~$300/mo | **~€480/mo** |

Compare this to Supabase Pro ($25/mo) → we'd hit their MAU caps and storage caps before €25 of self-hosting. Self-hosting wins on margin and gives us full ownership.

### What lives where

```
multizen-pro/services/
├── api/                  # Bun + Hono. Routes:
│   ├── /auth/*           # Better-Auth integration (Google + magic link)
│   ├── /me               # Current user + subscription state
│   ├── /profiles/*       # Cloud-sync metadata + signed R2 URLs
│   ├── /billing/webhook  # NOWPayments + LemonSqueezy callbacks
│   └── /chromium/manifest # Latest binary version, served per platform
├── update-server/        # Static R2-backed file server with delta-update logic
└── workspace-server/     # Team workspace + profile-lock coordination
```

Sign-in methods at launch: **Google OAuth + email magic link** via Better-Auth. Add later: Apple Sign In, GitHub OAuth.

### Why Better-Auth specifically

- Self-hosted, no managed-service dependency
- TypeScript native — same language as our stack
- Postgres backend out of the box
- Battle-tested OAuth flows (Google, GitHub, Apple) without us writing crypto
- Sessions in Redis, no JWT complexity for our scale
- Easy migration path if it doesn't work: it's just rows in our Postgres

## E2E encryption for cloud-synced profiles

Profiles hold session cookies — bearer tokens for every site the user is logged into. Server-side encryption is insufficient. Cloud blobs must be E2E so we cannot decrypt even with full DB access.

### Flow

1. User signs in (Google / email) → Supabase issues JWT.
2. First-time cloud-sync activation: user sets a passphrase. We generate a **12-word BIP39 recovery phrase** and show it once with explicit "we cannot recover this — write it down" warning.
3. Passphrase + per-account salt → scrypt → 256-bit encryption key. (Same KDF we already use for `.mzar` archives — code reuse.)
4. Profile data (cookies, localStorage, IndexedDB, fingerprint) encrypted client-side with AES-256-GCM.
5. Server stores opaque ciphertext + plaintext metadata (name, tags, `updatedAt`, sizeBytes) — metadata for list rendering and quota enforcement.
6. Conflict resolution v1: last-write-wins per profile. v2: 3-way cookie-set merge.
7. Forgotten passphrase = ciphertext is unrecoverable. Front-load the warning.

### Storage caps and abuse defense

| Tier | Per-profile cap | Total per account |
|---|---:|---:|
| Anonymous | n/a | n/a (local only) |
| Free | 100 MB | 300 MB |
| Pro | 200 MB | 5 GB |
| Team | 200 MB | 50 GB |

Hard limit enforced server-side on upload. Soft limit at 80% triggers an in-app banner. Abuse rate limit: 50 MB/profile/day upload velocity.

### Storage cost projection (Cloudflare R2)

| Paid users | Avg profiles | Avg blob | Total | R2 cost |
|---:|---:|---:|---:|---:|
| 100 Pro | 10 | 200 MB | 200 GB | ~$3/mo |
| 100 Team | 30 | 200 MB | 600 GB | ~$9/mo |
| 1000 Free | 3 | 100 MB | 300 GB | ~$5/mo |

Total at "1000 Free + 100 Pro + 50 Team" = 800 GB ≈ $12/mo on R2 ($0.015/GB stored, $0/GB egress within Cloudflare network). Free egress is the killer feature — we read blobs back to the desktop client without per-GB egress fees.

## Repo split

### Public OSS — `multizenteam/multizen-browser` (this repo, MIT)

```
apps/desktop/                # Electron + React UI
packages/
├── types/                   # Shared TS types
├── profile-manager/         # SQLite CRUD, .mzar archive
├── cdp-driver/              # CDP wrapper
├── mcp-server/              # MCP tools, HTTP/stdio transport
└── settings-store/          # JSON settings
```

Anyone can clone, build, run. Produces an Anonymous-tier build that, in **dev**, falls back to system Chrome and gives 1 profile. The patched Chromium binary download URL points to our CDN; only the Pro repo has the build pipeline that produces the binaries the CDN serves.

### Private — `multizenteam/multizen-pro` (planned, not public)

```
packages/
├── fingerprint-engine/      # Canvas / WebGL / Audio runtime patches (closed source)
├── chromium-patches/        # Patches against Chromium source — applied during build
├── chromium-build/          # Build pipeline (depot_tools + GH Actions self-hosted runner)
├── subscription-client/     # session token, /me polling, entitlement cache
├── cloud-sync-client/       # E2E encryption + R2 uploads
└── auth-client/             # OAuth + magic-link session glue

services/                    # Self-hosted on a Docker VPS — see "Backend stack" above
├── api/                     # Bun + Hono — auth, /me, profiles sync, billing webhooks
├── update-server/           # Caddy + R2 — patched Chromium binaries + manifests
└── workspace-server/        # Team workspace + profile-lock coordination

infra/
├── docker-compose.yml       # The whole prod stack
├── Caddyfile                # Reverse proxy + auto-TLS
└── postgres-schema.sql      # Migrations
```

The patched Chromium binary itself is built by the `chromium-build/` pipeline in this repo and uploaded to R2 by CI. The desktop client (which lives in the public OSS repo) only knows the manifest URL — it has no source-level dependency on the Chromium fork. That's how we keep the bootstrap-download client open while keeping our patches closed.

### Build modes

```sh
# Anonymous/Free build (anyone)
yarn build

# Pro build (us only — needs vendor/multizen-pro/ checked out)
yarn build:pro
```

Pattern in code:

```ts
// apps/desktop/src/main/entitlements.ts
let pro: ProBundle | null = null;
try {
  pro = require("@multizen-pro/subscription-client").load();
} catch {
  pro = null;
}

export function profileLimit(authState: AuthState): number {
  if (authState.kind === "anonymous") return 1;
  if (authState.kind === "free") return 3;
  if (pro?.entitlements.tier === "pro") return 10;
  if (pro?.entitlements.tier === "team") return 100;
  if (pro?.entitlements.tier === "enterprise") return Infinity;
  return 1;
}

export function cloudSync(): CloudSyncClient | null {
  return pro?.cloudSync ?? null;
}
```

## Migration semantics — never lose data

| Transition | Behavior |
|---|---|
| Anonymous → Free | The 1 anonymous profile gets `userId` set. Data stays local; user opts into cloud sync separately. |
| Free → Pro | Profiles unchanged. Storage cap raised. Same-day Chromium milestone updates start. |
| Pro → Team | Profiles unchanged. User can move profiles into shared workspace. |
| Pro → Free (downgrade) | Profiles 4–10 kept on disk + cloud, **locked from launching** with "Pro plan required" pill. Storage over 300 MB stays on cloud as read-only. No data is deleted. |
| Team → Pro | Workspace profiles become user-owned. Above 10, same lock behavior. |
| Pro → Anonymous (sign out) | Cloud sync turns off. Profiles 4+ locked. User can re-login any time to unlock. Cloud blobs preserved server-side for 90 days then GC'd. |

We never delete profile data on downgrade. We only lock launches on the excess. Trust-killing not to.

## Anti-piracy posture

- Patched Chromium is base for all tiers, but the **binary itself is closed-source**. The OSS repo only has the bootstrap-download client. The build pipeline is in the private repo.
- Even though Chromium is shipped to Anonymous users, our moat is *update freshness*: Pro/Team gets new milestones same-day, Free/Anonymous lags up to 7 days. Detection vendors update fast; lagging by a week is meaningful.
- Cracked clients don't get subscription-server updates → cannot upgrade to Pro/Team profile counts → indistinguishable from Free in features.

## Implementation roadmap

| Stage | Trigger | Build |
|---|---|---|
| **Now (pre-revenue)** | — | Anonymous tier hard-coded (1 profile, no auth). Chromium bootstrap with placeholder URL. UI shows "Sign up free for 3 profiles + multi-device" on 2nd profile attempt. |
| **Чили SpA + NOWPayments live** | Legal entity + payments | Hetzner VPS spun up with Docker Compose: Postgres + Redis + Caddy + Bun/Hono API + Better-Auth (Google + magic link). `/me` endpoint. EA users tied to Postgres rows. |
| **First $49 EA pre-orders** | Real demand | Pro tier active in subscription system. R2 bucket online with first patched Chromium build. |
| **50 paying Pro users** | Validated | Cloud sync (E2E with passphrase + BIP39 recovery). |
| **Pro retention healthy** | Day-30 retention >40% | Same-day Chromium milestone updates differentiated by tier. |
| **200 paying Pro users** | Pro is a real biz | Team tier — workspace, profile lock, audit log, RBAC. |

## Non-negotiables

- **Anonymous mode never phones home.** No telemetry, no analytics, no version-check (Chromium update check is opt-in via "check for updates" button only on Anonymous).
- **Free tier phones home only on login + sync.** No background pings.
- **Cloud is opt-in even on Free and Pro.** A user can run forever without enabling sync.
- **E2E encryption for any profile blob touching our servers.** We must be technically incapable of reading them.
- **Subscription state has 30-day offline grace period.** Never hard-lock.
- **No data deletion on downgrade.** Excess profiles get locked, not deleted. Cloud blobs preserved 90 days post-downgrade then GC'd.
- **Patched Chromium binary itself does not call home.** Only subscription-client + cloud-sync-client + auth-client + update-client do, and only when activated.
