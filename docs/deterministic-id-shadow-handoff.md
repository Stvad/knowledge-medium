# Handoff: deterministic-id "default shadows server" bug

Status as of this session. Two interim fixes have shipped; the real fix is still
open. This doc is self-contained so a fresh session can pick it up.

## The bug

Deterministic-id blocks — settings/prefs, ui-state, the user page, daily-note
seats, the Journal/Types/Properties/Recents pages — are **minted as speculative
defaults the moment they're read-as-absent** (`ensureStateChild` /
`getOrCreate*` in `src/data/stateBlocks.ts`), *before* the server's authoritative
version has materialized. The mint is a normal `repo.tx` write, so it gets a real
`now` `updated_at`.

Under Layout B the observer reconciles `blocks_synced` (staging) → `blocks` with
**wall-clock LWW**. A `now`-stamped default outranks the server's older
authoritative row, so on a fresh client the real synced config is **shadowed** by
the local default. It was *permanent*: both disk (`blocks`) and the in-memory
`BlockCache` held the default, and a reload rehydrated the cache from the
shadowed disk row, so nothing healed.

This hits **every** deterministic-id block, not just settings — any uniform fix
must hold for all of them or we just move the inconsistency around.

## Root cause — why it's not a one-line timestamp tweak

The shadow case and the **upload-window replay** case are *indistinguishable* to
the reconcile gate. Both present as: `materializable`, `hasPendingUpload = false`,
`localUpdatedAt > stagingUpdatedAt`.

| | local `blocks` row | authoritative server value | want |
|---|---|---|---|
| **default** | `now`-stamped default | the *older* config (default was insert-or-skipped, never accepted) | **server wins** |
| **replay** | a just-uploaded edit | the *newer* local edit (server accepted it; the older delivery is a stale in-flight read) | **local wins** |

- The original `localUpdatedAt >= stagingUpdatedAt` skip-stale (the `>` half)
  favored **local** → correct for replay, wrong for default (the shadow).
- Dropping it favors **server** → correct for default, wrong for replay: it
  reintroduces the QuickFind-freeze flicker (stale older delivery wakes handles
  to re-read SQL). That regression is guarded by
  `src/data/internals/invalidation.test.ts:645` ("LWW-rejected sync delivery does
  not invalidate handles") — treat that test as the canary.

No timestamp/pending rule wins both. PowerSync pre-Layout-B distinguished these
via checkpoint/operation ordering, not wall-clock; the `>` branch was Layout B's
lossy stand-in. **A correct fix needs a source-side discriminator that separates
a speculative default from a real edit.**

## What shipped this session (interim — heals on RELOAD, not live)

Both commits are on local `master`, **ahead of `origin/master` by 2 (not yet
pushed)**:

- **`e7fc79b2` — disk-gate relaxation.** `decideStagingRow`
  (`src/sync/observer/reconcile.ts`) now skip-stales only on `hasPendingUpload`
  **or** an *equal* stamp (the one deliberate guard, commit `429fd4b2`). The
  strictly-greater branch is gone, so the server's older value reaches **disk**
  and the shadow **heals on reload**. Scoped to the disk gate only — the cache's
  `applyIfNewer` LWW is unchanged, which keeps the transient replay write off the
  UI (no handle wake → no freeze). See the `KNOWN-PARTIAL` comment in that file.
- **`bbc7bffa` — one-time recovery for *existing* shadows.**
  `Repo.scheduleReconcileRescan(workspaceId)` (`src/data/repo.ts`, scheduled from
  `src/App.tsx` after the access gate). The relaxed gate only runs when a staging
  row is (re)processed, but a client that skip-staled under the old gate already
  consumed that row's `blocks_synced_changes` entry, and the server won't
  re-deliver an unchanged row — so a normal queue-driven startup never
  re-evaluates it. This re-runs `drainWorkspace`, which re-reads `blocks_synced`
  *directly* (bypassing the consumed queue) and re-applies the relaxed gate.
  Marker-gated (`reconcile_rescan_v1:<workspaceId>` in `client_schema_state`),
  deferred, windowed/resumable/idempotent, once per (workspace, client).

Net interim behavior:
- **New** divergences never form (server overrides the default on disk at drain).
- **Existing** divergences self-heal on first open after deploy.
- **But** only on **disk** — the live cache still shows the stale default this
  session and rehydrates from the healed disk on the next **reload**. Live-client
  recovery sequence: deploy → open (re-scan runs, deferred) → reload.
- **Replay tradeoff:** a stale older in-flight delivery for a just-drained edit is
  briefly clobbered on disk and re-heals via its authoritative upload echo —
  transient, and masked from the UI by the unchanged cache LWW.

## What remains — the real fix

Heal **live** (in-session, no reload) **and** drop the transient replay clobber,
by distinguishing a speculative default from a real edit at the source.

There is a reverted piece ready to reuse: `BlockCache.applyFromSync(after,
before)` + wiring in `invalidate.ts` (see `git show e7fc79b2^` era / the prior
diff in history). It heals the **cache** in-session by taking the observer's row
when the cache still matches the pre-apply `before`. But applied blindly with the
disk relaxation it *also* can't tell default from replay, so it reintroduces the
freeze. **The cache heal needs the same discriminator as the disk gate** — once
we have that, `applyFromSync` slots back on cleanly (only rows the disk gate
applies reach the cache, and those are then correctly server-wins).

### Options (already explored — don't re-derive)

**Rejected:**
- *Fake/sentinel `updated_at`* (e.g. `0`): breaks `updated_at >= created_at`, and
  genuinely-new singletons (a fresh daily note) show "edited 56 years ago" / sink
  in recency. "Path to madness."
- *`tentative` flag*: a synthetic boolean that spreads through the disk gate, the
  cache gate, upload suppression, a promote-on-edit step, and a migration. Same
  poison as the fake stamp.
- *Computed defaults / lazy ("`blocks` holds only real content")*: explicitly
  ruled out — the default resolver would have to be consulted on every read path
  including content queries (a daily-note seat's `daily-note:date` must be visible
  to date-range joins).
- *Drop deterministic ids*: breaks cross-device idempotency.

**Recommended — Option 1: provenance authority.** Record who wrote the row, which
is honest data we should arguably carry anyway:
- A deterministic-id mint sets `updated_by = SYSTEM` (a reserved non-user id).
  Real edits set `updated_by = <user>` — the engine does this automatically.
- Reconcile rule becomes: skip-stale iff
  `hasPendingUpload OR equal-stamp OR (strictly-newer AND updated_by != SYSTEM)`.
  A pristine system default yields to the server (heals); a real edit keeps the
  strictly-greater protection (replay-safe). **Self-clears** on the first user
  edit.
- No new schema, no migration, no upload-suppression, no promote step. The
  reverted `applyFromSync` cache work slots back on (heal live).
- Sharp edges: `updated_by` becomes load-bearing for conflict resolution; "repair"
  writes on an already-user-edited row must use `skipMetadata` so they don't reset
  authorship to SYSTEM; need a reserved system id real users can never hold; UI
  may want to hide "edited by System".
- Implementation touch points: `stateBlocks.ts` mint helpers (set author=SYSTEM);
  `materialize.ts` (`LocalRowState` gains `updatedBy` / an `isSystemMint` flag,
  read from the before-row it already loads); `reconcile.ts` (`decideStagingRow`
  gains the discriminator); re-add `applyFromSync` for the live cache heal.

**Option 3: confirmation-aware reconcile (bigger).** Stop using wall-clock as the
authority; track server-confirmed vs pending properly, and make the mint's
`insert-or-skip` upload *report* the rejection so the client discards its default
and pulls the server row. Most faithful to pre-Layout-B; largest change; really a
superset of Option 1 (it still needs "the default loses").

## Code map

- `src/sync/observer/reconcile.ts` — `decideStagingRow`, the disk gate (relaxed
  rule + `KNOWN-PARTIAL` comment).
- `src/sync/observer/materialize.ts` — `materializeStagingRows`: Phase-1 (pre-gate,
  outside lock) + Phase-2 (authoritative re-gate inside the write lock); builds
  `LocalRowState` from the `blocks` row + `ps_crud`. Where `updated_by` would be
  threaded for Option 1.
- `src/sync/observer/invalidate.ts` — `applySyncInvalidation`, the cache gate
  (currently `applyIfNewer`; `applyFromSync` was the reverted live-heal).
- `src/data/blockCache.ts` — `applyIfNewer` (`<=` LWW) / `setSnapshot` (force).
- `src/data/stateBlocks.ts` — `ensureStateChild` / `getUserBlock` /
  `getPluginPrefsBlock`: the deterministic-id mint helpers (set author=SYSTEM here).
- `src/data/repo.ts` — `scheduleReconcileRescan` (recovery),
  `scheduleWorkspaceBackfills`, `scheduleReprojection` (the existing
  marker-gated/deferred patterns to mirror).
- `src/services/powersync.ts` — `applyBlockCreates` (insert-or-skip; already keeps
  a minted default from clobbering the *server*) and `compactBlockCrudEntries`
  (PUT+PATCH fusion; same protection).
- Commit `429fd4b2` — rationale for the equal-stamp guard (keep it).
- `src/data/internals/invalidation.test.ts:645` — the replay/freeze canary.

## Operational state

- `chrome-prod-stvad` and `chrome` (the two clients we recovered earlier in the
  session by hand): once the 2 reconcile commits deploy, they heal automatically
  via `scheduleReconcileRescan` on first open — then a reload surfaces the correct
  config. No further manual surgery needed.
- The 2 reconcile commits are **local on `master`, not pushed** — push when ready.
- Unrelated, already on `origin/master` from earlier this session: `c38578b9`
  (guard: reject raw backfill writes to synced tables) and `ef0ad445` (restore
  daily-note:date backfill as an uploading workspace pass). There's also a
  scheduled check-in task (`check-daily-note-date-backfill`, fires 2026-06-12) for
  whether the daily-note:date backfill propagated — separate concern.
