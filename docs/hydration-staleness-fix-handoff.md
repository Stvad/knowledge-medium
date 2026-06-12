# Handoff: hydration staleness fix (`updated_at` overload → split + server-enforced monotonicity)

**Status: design agreed, ready to implement.** This doc is the implementation
brief. Author: investigation/design pass (Fable). Implementer: Opus.

Branch: `claude/hydration-staleness-fix-6iruwh`.

---

## TL;DR of the decision

`blocks.updated_at` is doing two incompatible jobs: **(a) the sync gate's
row-version / LWW discriminator** and **(b) the user-facing "last edited"
timestamp**. `{skipMetadata: true}` writes freeze it to serve (b), which breaks
(a): the row's synced content changes but the stamp doesn't, so peers reject the
download. Decision:

1. **Split the field.** `updated_at` becomes a pure **row-version** (advances on
   every content-changing write). Add **`user_updated_at`** (and keep
   `updated_by` semantics; see Q2 below) to carry the user-facing "last edited"
   meaning. Repoint display/sort consumers to `user_updated_at`.
2. **Enforce monotonicity server-side**, not client-side: the Postgres clamp
   trigger bumps `updated_at` to `greatest(NEW.updated_at, OLD.updated_at + 1)`
   whenever any content column actually changed. This makes `updated_at` a true
   monotonic row-version immune to client clock skew, same-ms collisions, AND
   skipMetadata freezes — all three failure modes at once.
3. **Retire the `system:<userId>` shadow apparatus.** With display moved off
   `updated_at`, speculative deterministic-id defaults can be minted at
   `updated_at = 0` and heal automatically (server always wins). Delete the
   provenance discriminator, the `strict`/`healing` ReconcileMode, and the
   `healWorkspace` healing path.
4. **Recovery rides for free:** a one-time `UPDATE blocks SET updated_at =
   updated_at + 1` (per workspace) re-replicates every row as strictly-newer, so
   every client's gate re-applies it and all latent stale rows converge.

This is "A2 with monotonicity enforced server-side." It keeps the client gate
nearly unchanged (its input just becomes trustworthy), rather than gutting it.

---

## Why this, not the alternatives (so you don't re-litigate)

- **Pure client-side A2** (bump `updated_at` on every local write, no server
  change) fixes skipMetadata + same-ms but **leaves clock-skew staleness**:
  `apply_block_patches` assigns `updated_at = COALESCE(patch->>'updated_at',
  updated_at)` (straight assignment, `20260527180103_add_apply_block_patches_rpc.sql:63`)
  and the clamp only clamps *future* stamps down — so a slow-clock client's newer
  write can regress the stamp and be rejected by peers forever. The server bump
  closes this.
- **Gut the gate** (drop the timestamp branch, trust PowerSync echo to heal): we
  confirmed via PowerSync's [consistency](https://docs.powersync.com/architecture/consistency)
  + [write-checkpoint](https://docs.powersync.com/handling-writes/custom-write-checkpoints)
  docs that `blocks_synced` is checkpoint-atomic, monotonic, and write-checkpoint
  gated, so clobbers DO self-heal. It's *viable* but bets correctness on observer
  drain/watermark interleavings holding under PowerSync's guarantees, and this
  codebase has scar tissue here (the QuickFind-freeze incident, commit `429fd4b2`).
  Enforcing monotonicity is cheap defense-in-depth that makes the existing guards
  *provably* correct instead of approximately so.
- **Content-aware gate / deterministic tiebreak:** re-opens the stale-read hazard
  the equal-stamp skip exists to prevent. Rejected.

---

## The bug, precisely (root cause record)

`decideStagingRow` (`src/sync/observer/reconcile.ts:113-138`) gates hydration on
`updated_at` strictly-newer. `{skipMetadata: true}` (`txEngine.ts:730-736`) skips
the `updated_at` bump for bookkeeping writes. The column-narrow upload trigger
`blocks_upload_update` (`clientSchema.ts:542-560`, payload `blockUploadPatchJsonSql`)
fires because a tracked column changed but emits the PATCH **without**
`updated_at`. Server applies column-LWW → content changes, stamp frozen. Peer's
`decideStagingRow` sees equal/older stamp → `skip-stale` → the change never
reaches the peer's `blocks` table (permanent under Layout B: the gate is in front
of the *persistent* write now, so reload doesn't heal — unlike pre-Layout-B,
where PowerSync's unconditional raw-table put kept disk converged and only the
in-memory cache could be transiently stale).

**Blast radius — every `skipMetadata: true` write to a synced column:**

| Site | Synced column | Severity |
|---|---|---|
| `src/plugins/alias/syncProcessor.ts:189` | **`content`** | user-visible text stale on peers |
| `src/plugins/alias/syncProcessor.ts:186` | `properties_json` (aliases) | aliases/backlinks diverge |
| `src/plugins/references/renameProcessor.ts:249` | `references_json` (many blocks) | backlinks stale workspace-wide after a rename |
| `src/plugins/references/referencesProcessor.ts:213` | `references_json` | backlinks/typed-ref stale |
| `src/data/internals/normalizeReferencesProcessor.ts:54` | `references_json` | same |
| `src/plugins/references/mergeRetargetProcessor.ts:94` | `references_json` | same |
| `src/data/repo.ts:1747` | `references_json` | same |
| `src/plugins/daily-notes/dailyNotes.ts:210,234` | `parent_id`/`order_key` | reparent invisible to peers |

This is the same staleness `docs/field-level-sync-merge.md` (on hold) flagged for
`references_json`; this fix subsumes it for all columns.

---

## Implementation plan

Order matters for rollout (server first, invisible to old clients; then client).

### 1. Supabase migration (server)

New migration under `supabase/migrations/` (use the `supabase` skill to write +
`db push`). Contents:

- **Add columns** to `public.blocks`:
  - `user_updated_at bigint` — backfill `= updated_at` for existing rows; NOT NULL
    after backfill. Carries user-facing "last edited."
  - (Decide Q2) optionally `user_updated_by text` — backfill `= updated_by`.
- **Monotonic bump in the clamp trigger.** Extend `blocks_clamp_updated_at`
  (`20260510222352_consolidated_initial.sql:168`) so that on `UPDATE`, when any
  *content-bearing* column `IS DISTINCT FROM OLD` (`parent_id, order_key, content,
  properties_json, references_json, deleted`), set
  `NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at + 1)` **after** the
  existing future-clamp. INSERT path unchanged except future-clamp. This makes the
  server the monotonicity authority for both the literal-PATCH path and the RPC.
  - Verify it composes with `apply_block_patches` (the RPC UPDATEs `blocks`, so
    the BEFORE trigger fires on its writes too — good, no RPC change strictly
    needed, but double check the RPC isn't `SET session_replication_role` or
    otherwise bypassing triggers; it's `SECURITY INVOKER`, normal UPDATE → trigger
    fires).
  - `user_updated_at` must NOT be in the content-change test (it's metadata), so a
    pure user-timestamp change doesn't self-trigger a version bump loop.
- **Recovery touch (separate, run after deploy):** `UPDATE blocks SET updated_at =
  updated_at + 1;` — batched per workspace if large. Forces re-replication of every
  row as strictly-newer → clients re-apply → latent staleness converges. Because
  `user_updated_at` is already backfilled and untouched, display is unaffected.
  Keep this as a documented manual/ops step or a guarded one-shot, not auto-run on
  every deploy.
- pgTAP coverage: content-change bumps `updated_at`; metadata-only
  (`user_updated_at`/`updated_by`) change does NOT bump; equal-content re-PATCH is
  a no-op; clock-skew regression is clamped up not down.

### 2. Sync config

After adding columns to `src/data/blockSchema.ts` (next step), run
`yarn gen:sync-config` and commit `powersync/sync-config.yaml`. `user_updated_at`
(+ `user_updated_by` if chosen) must sync. Deploy with the `powersync` skill.
**Plaintext columns** — fine for e2ee workspaces (stamps are not encrypted; the
content-change test keys off ciphertext columns which DO change when content does).

### 3. Client schema / codecs

- `src/data/blockSchema.ts`: add `user_updated_at` to `BLOCK_STORAGE_COLUMNS`
  (and `BLOCK_SYNCED_*` shape), the `BlockData`/`BlockRow` types, `parseBlockRow`,
  and the domain-shape projection (`blockJsonObjectSql` / `BLOCK_DOMAIN_COLUMNS`).
  Mirror for `user_updated_by` if chosen.
- `src/data/internals/clientSchema.ts`: add the column to `BLOCK_UPLOAD_COLUMNS`
  so it round-trips on upload (and is in the column-narrow PATCH diff).
- Codecs (`src/data/api/codecs.ts`) + `src/data/api` `BlockData` if the public API
  surface exposes it.

### 4. TxEngine — the field split

`src/data/internals/txEngine.ts`:

- `metadataPatch(id, skipMetadata)` currently returns `{}` when `skipMetadata`.
  New semantics:
  - **Always** bump `updated_at` (row-version) and `updated_by` (writer) — even
    for skipMetadata writes. (Reconsider `updated_by` per Q2.)
  - Only bump `user_updated_at` (+ `user_updated_by`) when **NOT** `skipMetadata`.
  - So skipMetadata stops meaning "freeze everything" and starts meaning "this is
    a system/bookkeeping write: advance the row-version, don't touch user-edit
    fields."
- `buildNewBlockRow`: set `user_updated_at = now()` (display) on normal creates.
  For `systemMint` speculative defaults, set **`updated_at = 0`** (row-version
  "nothing real yet") and `user_updated_at = now()` (so recency/display is sane).
  This is what retires the shadow discriminator — see step 6.
- The existing insert `skipMetadata` path (`ts = 0, createdBy = ''`) — reconcile
  with the new split; bookkeeping inserts are rare, confirm callers.

### 5. Display/sort consumer audit

Repoint everything that reads `updatedAt` for **display/recency/sort** to
`userUpdatedAt`; leave everything that reads it for **gating/ordering/version**.
Bounded list to check (from grep): `src/plugins/daily-notes/spreadBlockDates.ts`,
`src/utils/copy.ts`, `src/utils/selection.ts`, `src/plugins/geo/query.ts`,
`src/data/blockCache.ts` (fingerprint/dedup — keep on `updated_at`),
`src/hooks/block.ts`, `src/extensions/*`. Grep `updatedAt`/`updated_at` and
classify each use. The cache `applyIfNewer`/gate stays on `updated_at`.

### 6. Reconcile gate simplification

`src/sync/observer/reconcile.ts` + `materialize.ts` + `observer.ts`:

- With server-monotonic `updated_at` and `updated_at = 0` shadows, you can
  **delete**: `ReconcileMode` (`strict`/`healing`), `isOwnSystemMint`,
  `LocalRowState.isOwnSystemMint`, the `serverWins`/strictly-newer provenance
  branch, `healWorkspace` + `Repo.scheduleReconcileRescan`'s healing mode, and
  `systemAuthor`/`isSystemAuthor` usage in the mint path (`api/user.ts`,
  `stateBlocks.ts`, `TxInsertOpts.systemMint`).
- The gate reduces to:
  ```
  if defer            -> defer
  if hasPendingUpload -> skip-stale            // un-uploaded local edit wins
  if localUpdatedAt === stagingUpdatedAt -> skip-stale   // equal ⟺ identical content (now provable)
  else                -> apply                 // server row is newer-or-shadow-heal
  ```
  Note `localUpdatedAt > stagingUpdatedAt` (the old strict-protect case) now
  **applies the server row** — correct, because a genuinely-newer local edit is
  either pending (caught above) or its echo will re-assert it (PowerSync
  write-checkpoint). The only cost is the transient post-ack/pre-echo replay
  flicker, which self-heals.
- **Keep `429fd4b2`'s equal-stamp skip** — but its justification upgrades from
  "stale in-flight read defense" to "equal server stamp ⟺ identical content
  (monotonic +1 guarantees it); same-ms LOCAL optimistic writes still collide, so
  the skip still earns its place." Update the comment.
- **The QuickFind-freeze canary** (`src/data/internals/invalidation.test.ts:645`,
  "LWW-rejected sync delivery does not invalidate handles"): re-derive what it
  should assert under the new gate. The freeze came from an older delivery waking
  handles to re-read SQL. Under the new gate that older delivery now *applies*
  (server-wins) — so the test's premise changes. Either (a) prove the apply is
  immediately corrected by the echo within the same settle and handles converge,
  or (b) if a real flicker risk remains, gate the cache invalidation (not the disk
  apply) on `applyIfNewer` so the UI doesn't wake on the transient. Do NOT delete
  the canary without a replacement assertion.

### 7. Recovery (client side, optional)

The server `updated_at + 1` touch (step 1) is the primary recovery and needs no
client code. If you want a client-only recovery that doesn't depend on the server
touch (e.g. for a client that already consumed the `blocks_synced_changes` entry),
reuse the existing `drainWorkspace` direct-rescan (`observer.ts:272`) — it re-reads
`blocks_synced` directly and, under the simplified gate, re-applies divergent rows.
A marker-gated one-shot like the retired `scheduleReconcileRescan` is the pattern.

**Discovery query (read-only, for measuring blast radius before/after):** diff
`blocks_synced` vs `blocks` on content columns where `blocks.updated_at >=
blocks_synced.updated_at` (the rows the old gate rejected). Run on a device to
quantify; not required for the fix.

---

## Open questions for the implementer to settle (don't block on me)

**Q1 — `updated_at = 0` sentinel vs `created_at`.** No DB CHECK enforces
`updated_at >= created_at` (verified — it's only a soft code assumption), so a
`0` row-version is safe at the storage layer. Confirm no code path divides-by or
asserts on `updated_at >= created_at`; if any do, they're display code → should be
on `user_updated_at` anyway (step 5).

**Q2 — `updated_by` coherence.** If `updated_at` bumps on skipMetadata writes but
`updated_by` stays frozen, `(updated_at, updated_by)` is incoherent ("vN by U" for
a write U didn't author). Two clean options:
  - **(A)** Treat `updated_by` as a *user* field (freeze it with `user_updated_at`
    on skipMetadata; add no new column). Simplest; "who last touched the row at the
    storage level" is lost but we don't query it. The gate no longer reads
    `updated_by` after step 6, so nothing depends on it being the row-version
    author.
  - **(B)** Add `user_updated_by`, let `updated_by` track the actual writer
    (bookkeeping included). More honest, one more synced column.
  Recommend **(A)** unless you find a consumer that needs storage-level authorship.

**Q3 — rollout coordination.** Fleet is 2 users / 5 devices with the documented
drain-then-swap playbook (`field-level-sync-merge.md` §Rollout). Sequence: deploy
migration (invisible to old clients — old clients send literal `updated_at`
patches, server bump still applies, no regression) → drain each device's `ps_crud`
→ ship client bundle → run the recovery touch. Confirm old-client literal patches
during the mixed-version window behave (they will: the server bump is
client-agnostic).

**Q4 — does the monotonic bump interact with `blocks_history`?** The history
trigger (`20260522062437_add_blocks_history.sql`) records per-column diffs and
skips no-op UPDATEs — a `+1` updated_at bump on a content change is part of the
same UPDATE, so it's recorded once, fine. Verify the recovery touch
(`updated_at + 1` on *every* row) doesn't flood history with N spurious rows — if
it does, either suppress history for that one maintenance UPDATE or accept it
(2-user fleet, bounded).

---

## Code map

- `src/sync/observer/reconcile.ts` — `decideStagingRow` (gate to simplify).
- `src/sync/observer/materialize.ts` — `LocalRowState` build, Phase 1/2 gate calls.
- `src/sync/observer/observer.ts` — `drainWorkspace`/`healWorkspace` (drop healing).
- `src/data/internals/txEngine.ts` — `metadataPatch`, `buildNewBlockRow` (the split).
- `src/data/internals/clientSchema.ts` — `BLOCK_UPLOAD_COLUMNS`, upload triggers.
- `src/data/blockSchema.ts` — column list, types, `parseBlockRow`, domain projection.
- `src/data/api/user.ts` — `systemAuthor`/`isSystemAuthor` (retire from mint path).
- `src/data/stateBlocks.ts` — speculative mint sites (switch to `updated_at = 0`).
- `src/data/repo.ts` — `scheduleReconcileRescan` (drop healing variant), `:1747`.
- `supabase/migrations/20260510222352_consolidated_initial.sql:168` — clamp trigger.
- `supabase/migrations/20260527180103_add_apply_block_patches_rpc.sql:63` — RPC UPDATE.
- `docs/deterministic-id-shadow-handoff.md` — why `system:<userId>` existed (now retired).
- `docs/field-level-sync-merge.md` — the on-hold doc that flagged the refs subset.
- `src/data/internals/invalidation.test.ts:645` — the QuickFind-freeze canary.

## Verification

`yarn run check`. Plus: new pgTAP for the monotonic bump; client tests for the
field split (`metadataPatch` skipMetadata advances `updated_at` not
`user_updated_at`; shadow mint at `updated_at = 0` heals); a two-client/conflict
test that a skipMetadata refs write on A lands on B; updated reconcile tests
(delete the mode/provenance cases, add the "older-stamp server row applies" case);
the canary replacement.
