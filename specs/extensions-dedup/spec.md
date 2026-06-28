# Spec — Extension dedup (shared store) · `extensions-dedup`

Phase 2 of the browser-extensions feature. Built on `specs/extensions-dedup/research.md`.
Resolves GitHub issue #10 (ahive): "avoid duplicate copies of the same extension, one per
instance."

## Problem / Why

Every extension is currently unpacked into `{profileDataDir}/extensions/<uuid>/` — a **full
copy per profile**. Real wallets (MetaMask, Phantom) are 16–60 MB, so a user with 20
profiles all running uBlock + MetaMask burns hundreds of MB on identical bytes. This is the
complaint in issue #10.

There is a second, less obvious problem the same change fixes. Today each install gets a
**random per-profile extension ID** (Chromium derives an unpacked extension's ID from a hash
of its absolute path when the manifest has no `key`). No real Chrome user has a random
extension ID — it's an anti-fingerprinting anomaly. Websites probe installed extensions via
`chrome-extension://<id>/<web_accessible_resource>`; a random per-profile ID is an
"impossible" surface. Exposing the **genuine Chrome Web Store ID** instead (the same ID
millions of real users have) is strictly more natural and does **not** link a user's
profiles to each other.

## Goal & non-goals

**Goals**
- Store each unique extension **once** on disk, shared across all profiles that use it.
- Keep per-profile extension **state** (logins, `chrome.storage`, cookies, IndexedDB) fully
  isolated — no regression from Phase 1.
- Expose the **genuine store ID** for store/CRX installs (inject the real developer public
  key) so profiles look like normal installs and are not cross-linked by a shared anomalous
  ID.
- Reclaim disk automatically: when the last profile referencing a shared extension drops it,
  the shared copy is deleted.

**Non-goals**
- **Eager migration** of existing per-profile copies. Already-installed extensions stay
  where they are (per-profile, random ID); only NEW installs use the shared store. (User
  decision: lazy migration.)
- Cross-version consolidation / forced auto-upgrade. Different versions coexist (keyed by
  `id + version`). (User decision.)
- Extension auto-update / version-bump automation (separate future work).
- CRX **signature verification** (unchanged trust model: HTTPS to Google / user-provided
  file).
- Any UI redesign of the Extensions section beyond what these changes require.
- MV2 support (still rejected).

## User stories / scenarios

1. **Same extension across many profiles.** A user adds uBlock Origin to profile A and later
   to profile B. The bytes are stored once; both profiles load it. Disk does not grow on the
   second add.
2. **Genuine store identity.** A user adds MetaMask from the Web Store to two profiles. A
   site probing `chrome-extension://<metamask-store-id>/...` sees MetaMask's real, public ID
   in both — identical to what any normal MetaMask user shows — and cannot infer the two
   profiles belong to one person from the extension ID.
3. **Folder/zip dev extension.** A user uploads an unpacked folder or a `.zip` with no
   recoverable key. It still installs and loads; it keeps a deterministic (path-derived) ID,
   as a real developer-loaded unpacked extension would.
4. **Removal frees disk.** A user removes an extension from the only profile that had it; the
   shared copy is deleted. If another profile still uses it, the shared copy stays.
5. **Profile deletion.** Deleting a profile drops its references; any shared extension no
   longer referenced by any profile is reclaimed.
6. **Two versions coexist.** Profile A has uBlock 1.50; profile B installs 1.51. The store
   holds both; each profile loads its own version. Removing A leaves 1.51 for B and reclaims
   1.50.
7. **Legacy install still works.** A profile that installed an extension before this release
   continues to launch and run that extension unchanged (resolver handles legacy per-profile
   dirs alongside new shared refs).
8. **Concurrent install.** Two profiles install the same extension+version at the same time;
   exactly one shared copy results, both profiles reference it, neither install errors.
9. **Companion "Add to MultiZen".** The in-browser button behaves identically to today from
   the user's view; under the hood the install lands in the shared store with the genuine ID.

## Acceptance criteria

Storage & dedup
- [ ] A new install writes the unpacked extension to a single shared location keyed by
      `id + version`; installing the same `id + version` into a second profile adds **no**
      new copy of the bytes.
- [ ] Total on-disk size for N profiles sharing one extension is ~1× the extension, not N×
      (verified by inspecting the store + profile dirs after multi-profile install).
- [ ] Different versions of the same extension coexist as separate shared entries.

Stealth / identity
- [ ] For a Web Store or CRX install where the developer public key is recoverable, the
      loaded extension's ID equals the **genuine Chrome Web Store ID** (e.g. uBlock =
      `cjpalhdlnbpafiamejdnhcphjbkeiagm`) and is **identical across profiles**.
- [ ] The same store extension installed in two profiles exposes the **same** store ID (not
      two different random IDs).
- [ ] A folder/zip install with no recoverable key still installs and loads, with a stable
      deterministic ID.
- [ ] If key recovery fails for any reason, the install **still succeeds** with a
      path-derived ID (no install is ever blocked by key extraction).

Isolation (no Phase-1 regression)
- [ ] Logging into an extension (e.g. a wallet/account) in profile A does **not** appear in
      profile B, even though both load the same shared files.
- [ ] Two profiles running concurrently can both load the same shared extension without
      errors or one corrupting the other's state.

Lifecycle / GC
- [ ] Removing an extension from the last referencing profile deletes the shared copy.
- [ ] Removing it from one of several referencing profiles leaves the shared copy intact.
- [ ] Deleting a profile reclaims any shared extension no longer referenced by any profile.
- [ ] GC never deletes a shared entry that is still referenced by some profile (refcount is
      derived from the live profiles table, not a stored counter).

Migration / compatibility
- [ ] Existing per-profile installs from before this release continue to load and function
      after upgrade (no forced migration, no breakage).
- [ ] The launch path resolves both legacy per-profile extension dirs and new shared refs in
      the same profile.
- [ ] A profile with a mix of legacy and shared extensions launches correctly.

Concurrency / robustness
- [ ] Two simultaneous installs of the same `id + version` converge to one shared copy with
      both profiles referencing it and no error surfaced to either.
- [ ] An interrupted/partial install never leaves a half-written shared entry that a later
      launch would load (atomic publish).

Enable/disable & companion
- [ ] Enable/disable remains a per-profile toggle and works for shared extensions.
- [ ] The companion "Add to MultiZen" flow installs into the shared store with the genuine
      ID and otherwise behaves as in Phase 1.

Quality gate
- [ ] Typecheck/build passes; existing extension behaviors (install from file/folder/web
      store, list, remove, toggle, launch-load) still work.

## Open questions

1. **Orphan sweep on startup?** Inline GC on remove/profile-delete covers the normal path.
   Do we also want a best-effort sweep at app start to reclaim shared entries orphaned by a
   crash mid-delete? (Lean: yes, cheap and self-healing — confirm in /plan.)
2. **Legacy re-install upgrade.** If a profile already has a legacy per-profile copy and the
   user re-installs the same extension, should that re-install move it into the shared store
   (opportunistic per-item migration) or stay lazy/per-profile? (Lean: opportunistic — a
   re-install is a fresh install path anyway.)
3. **Store ID change for migrated/legacy items.** Because migration is lazy, legacy installs
   keep their random ID until re-installed. Acceptable per the scope decision — just
   confirming no user-visible ID stability guarantee is expected for pre-existing installs.

---

Spec path: `specs/extensions-dedup/spec.md`. Review this before `/plan extensions-dedup`.
