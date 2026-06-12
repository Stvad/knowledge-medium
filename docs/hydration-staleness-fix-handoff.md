# Handoff: hydration staleness fix (`updated_at` overload → split + server-enforced monotonicity)

**Status: design agreed; r2 after adversarial review — ready to implement.**
This doc is the implementation brief. r1 was reviewed by two adversarial
passes (client-side and server/rollout-side) plus the Codex bot on PR #131;
r2 folds in their corrections. The five r1 errors that would have broken the
implementation are marked **[r2]** inline so the implementer knows which
parts are load-bearing corrections, not optional polish.

Branch: `claude/hydration-staleness-fix-6iruwh` (PR #131).

---

## TL;DR of the decision

`blocks.updated_at` is doing two incompatible jobs: **(a) the sync gate's
row-version / LWW discriminator** and **(b) the user-facing "last edited"
timestamp**. `{skipMetadata: true}` writes freeze it to serve (b), which breaks
(a): the row's synced content changes but the stamp doesn't, so peers reject the
download. Decision:

1. **Split the field.** `updated_at` becomes a pure **row-version** (advances on
   every content-changing write, locally monotonic per row). Add
   **`user_updated_at`** carrying the user-facing "last edited"; `updated_by`
   stays a user-pair field (frozen together with `user_updated_at` on
   skipMetadata writes — Q2 option A). Repoint display/sort consumers to
   `user_updated_at`.
2. **Enforce monotonicity server-side** in the clamp trigger: an unconditional
   floor `greatest(NEW.updated_at, OLD.updated_at)` on every UPDATE, **plus 1**
   when any content column actually changed. Immune to client clock skew,
   same-ms collisions, AND skipMetadata freezes — all three failure modes.
3. **Speculative deterministic-id mints stamp `updated_at = 0`** (the
   "pristine" sentinel) instead of carrying a `system:<userId>` author for the
   gate. The gate gets a stamp-0 exemption so a 0-stamped local row always
   yields to the server. The `systemMint` opt is **retained and repurposed**
   (it now selects the 0 stamp); the `system:` author helpers are retained for
   historical rows and display, but the gate stops reading provenance.
4. **The gate simplifies** to: defer → pending-upload skip → equal-nonzero-stamp
   skip → apply. `ReconcileMode` (`strict`/`healing`), `isOwnSystemMint`, and
   `healWorkspace`'s healing variant are deleted.
5. **Recovery** is a **scoped** server-side touch (`updated_at = updated_at + 1`
   on the actually-divergent rows, enumerated from `blocks_history`), with
   pre-checks, falling back to a full touch only if needed.

This is "A2 with monotonicity enforced server-side." The client gate barely
changes shape — its input becomes trustworthy.

### Design invariants (what the rest of the doc serves)

- **I1 (server):** if the server row's content differs from any client's local
  row content, the server row's `updated_at` is strictly greater than that
  client's local stamp — *for stamps > 0*. Enforced by the trigger floor+bump.
- **I2 (sentinel):** `updated_at = 0` means "speculative local default, never
  user-edited, server always wins (unless an upload is pending)". It is the
  only stamp exempt from I1 and from the equal-stamp skip.
- **I3 (local):** local stamps are per-row monotonic too
  (`max(now, before.updated_at + 1)`), so a fresh local edit can never stamp at
  or below the row's current stamp even when the server has ratcheted ahead of
  this device's clock.

---

## Why this, not the alternatives (so you don't re-litigate)

- **Pure client-side A2** (bump `updated_at` on every local write, no server
  change) fixes skipMetadata + same-ms but **leaves clock-skew staleness**:
  `apply_block_patches` assigns `updated_at = COALESCE(patch->>'updated_at',
  updated_at)` (straight assignment, `20260527180103_add_apply_block_patches_rpc.sql:63`)
  and the clamp only clamps *future* stamps down — so a slow-clock client's newer
  write can regress the stamp and be rejected by peers forever. The server floor
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
- **Keep `system:<userId>` as the gate discriminator:** the split removes the
  only recorded objection (`deterministic-id-shadow-handoff.md`, "Rejected:
  fake/sentinel updated_at") to the simpler 0-stamp sentinel — that objection
  was display pollution ("edited 56 years ago"), and display moves to
  `user_updated_at`. The 0 stamp is strictly simpler for the gate; provenance
  display survives independently (see step 6).

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

Two sibling failure modes share the root cause and are fixed by the same
invariant: same-ms same-client stamp collisions, and cross-client clock-skew
stamp regressions. This subsumes the `references_json` staleness flagged in the
on-hold `docs/field-level-sync-merge.md`.

---

## Implementation plan

Steps are ordered for rollout. **[r2]** markers = corrections from review.

### 1. Supabase migration (server)

New migration under `supabase/migrations/` (use the `supabase` skill).

- **Add column** `user_updated_at bigint` to `public.blocks` — **nullable, NO
  `NOT NULL`** **[r2]**. A NOT NULL would make old-client CREATEs in the
  mixed-version window violate 23502, which `classifyUploadError` treats as
  permanent (`src/services/uploadErrorClassifier.ts:31-32`) → the whole tx is
  quarantined to `ps_crud_rejected` → **silent data loss** for blocks created on
  not-yet-upgraded devices. (Confirmed independently by the Codex review on
  PR #131.) Population is guaranteed trigger-side instead (next bullet); a
  later migration MAY tighten to NOT NULL once the fleet is upgraded, or never —
  the trigger makes it an invariant anyway. Postgres can't express
  `DEFAULT updated_at` (no cross-column defaults), hence the trigger.
- **Extend `blocks_clamp_updated_at`**
  (`20260510222352_consolidated_initial.sql:168`):
  - INSERT and UPDATE: existing future-clamp on `updated_at`/`created_at` stays
    first. Then `NEW.user_updated_at := COALESCE(NEW.user_updated_at,
    NEW.updated_at)` — populates old-client writes and pre-split rows.
  - UPDATE only, **after** the future-clamp: **unconditional floor**
    `NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at)`; **plus**, when
    any content column changed (`parent_id, order_key, content, properties_json,
    references_json, deleted` — each `IS DISTINCT FROM OLD`), add 1:
    `NEW.updated_at := greatest(NEW.updated_at, OLD.updated_at + 1)`.
    **[r2] The floor must be unconditional**, not content-gated: a
    metadata-only PATCH from a slow-clock client would otherwise regress the
    stamp through the RPC's straight assignment, and a later non-content write
    would un-ratchet a previously floored stamp — either breaks invariant I1.
    The floor may exceed wall-clock slightly under rapid writes; that's inherent
    to ratcheting and harmless (the future-clamp runs before the floor by
    design, not after).
  - `user_updated_at` / `user_updated_by` / `updated_by` / `created_*` are NOT
    in the content-change test (metadata must not self-trigger version bumps).
- **Extend `apply_block_patches`** **[r2]**: the RPC's UPDATE is a closed column
  list (`20260527180103:55-67`) — unknown patch keys are silently ignored, so
  without this change every new-client PATCH **drops `user_updated_at`** and
  the user-facing half of the split ships permanently frozen. Add
  `user_updated_at = COALESCE((patch->>'user_updated_at')::bigint,
  user_updated_at)` to the UPDATE. (r1 said "no RPC change strictly needed" —
  that was wrong.)
- **Backfill** `UPDATE blocks SET user_updated_at = updated_at WHERE
  user_updated_at IS NULL` — **with `ALTER TABLE public.blocks DISABLE TRIGGER
  blocks_record_history_trg` around it** **[r2]**, else one history row per
  block (`20260522062437:167-170`; the no-op skip doesn't help — the column DID
  change). Do NOT use `session_replication_role = replica` (it would also
  disable the clamp and e2ee-validation triggers). Re-enable after. Same
  bracketing applies to the recovery touch (step 7).
- **One-time `system:` cleanup [user-requested] — does NOT run here.** **[r3]
  Codex P1:** it must run in the **post-upgrade recovery phase** (step 7 /
  rollout step 5), not in this initial migration. If zeroed now, any old client
  that mints a deterministic-id row *after* this runs but *before* it upgrades
  writes a fresh **nonzero** `system:<uid>` row — and the new gate recognizes
  pristine only as `updated_at === 0`, with the provenance branch deleted, so
  that shadow would never yield. Running it once after the fleet is fully on the
  new bundle (which mints pristine rows at `updated_at = 0` directly, so no new
  `system:` rows are created) catches every historical row and nothing
  regenerates them. SQL + rationale live in step 7.
- **pgTAP**: content-change bumps `updated_at` by ≥1 over OLD; metadata-only
  change floors but does not bump; clock-skew regression attempt is floored up;
  old-style INSERT without `user_updated_at` gets it populated; RPC PATCH
  carries `user_updated_at` through. Note **[r2]**: the "equal-content re-PATCH
  is a no-op" case holds for **plaintext only** — e2ee re-uploads re-seal with a
  fresh nonce (`src/sync/crypto/aead.ts:24`, `transform.ts:110-127`), so
  ciphertext differs and the bump fires; harmless (peers apply
  identical-plaintext), but don't write the test expecting no bump for e2ee.
- Cross-reference: if the on-hold `field-level-sync-merge.md` work is ever
  revived, its `app.skip_blocks_clamp` GUC bypass must be reconciled with the
  floor (a bypassed write must still not regress the stamp).

### 2. PowerSync sync rules — a hard-ordered rollout step [r2]

r1 omitted this step entirely; its ordering is load-bearing. The
`blocks_synced` stream's column list is generated from `BLOCK_STORAGE_COLUMNS`
(`scripts/gen-sync-config.ts`), so after step 3 run `yarn gen:sync-config`,
commit `powersync/sync-config.yaml`, and deploy with the `powersync` skill —
**after** the Supabase migration (the rules reference the new column and error
against the old schema) and **before** the client bundle. Old client + new
rules is safe (extra downloaded column simply isn't bound). New client + old
rules is additionally defended by making the local column **nullable** (step 3)
so a missing stream column binds NULL instead of failing NOT NULL on every
downloaded row.

Plaintext column — fine for e2ee workspaces (stamps are never sealed; only
`content`/`properties_json`/`references_json` are, `transform.ts:51`, enforced
server-side by `20260529120000:211-214`).

### 3. Client schema / codecs / local migration

- **Local SQLite migration for existing devices [r2]:** `blocks` and
  `blocks_synced` are `CREATE TABLE IF NOT EXISTS` (`blockSchema.ts:66-83`,
  run from `repoProvider.ts`) — adding the column to `BLOCK_STORAGE_COLUMNS`
  does NOT add it to existing DBs, but it immediately appears in every
  generated statement (`INSERT_SQL`, the observer's `UPSERT_BLOCK_SQL`, the
  raw-table put) → every existing device fails with "no such column" at first
  write/sync. Fresh-DB tests won't catch it. Reuse the existing pattern:
  `ensureWorkspaceE2eeColumns` (`src/data/workspaceSchema.ts:74-83`,
  `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`), called from the same
  bootstrap site — apply to BOTH tables, then a one-shot local backfill
  `user_updated_at = updated_at` (a `client_schema_state` marker if needed,
  though an idempotent `UPDATE ... WHERE user_updated_at IS NULL` self-gates).
- **Local column is nullable** (`user_updated_at INTEGER`, no NOT NULL);
  `parseBlockRow` falls back: `userUpdatedAt: row.user_updated_at ??
  row.updated_at`. This absorbs old-rules downloads (step 2) and pre-migration
  `row_events` snapshots (step 4).
- Add the column to `BLOCK_STORAGE_COLUMNS` (`src/data/blockSchema.ts:37`),
  `BlockRow`/`BlockData`, **`BLOCK_SNAPSHOT_JSON_FIELDS`** + 
  `buildBlockSnapshotJsonSql`/`parseBlockSnapshotJson` (`blockSchema.ts:130-163`),
  `blockToRowParams` (`blockSchema.ts:195`), and `blockJsonObjectSql` in
  **clientSchema.ts** (`:351-366`, the row_events projection). (r1 named
  `BLOCK_SYNCED_*`/`BLOCK_DOMAIN_COLUMNS` — those identifiers don't exist;
  `blocks_synced` shares `BLOCK_STORAGE_COLUMNS`.)
- `src/data/internals/clientSchema.ts`: add to `BLOCK_UPLOAD_COLUMNS` so the
  column rides PUTs and the column-narrow PATCH diff.
- Codecs / public `BlockData` surface (`src/data/api`).

### 4. TxEngine — the field split

`src/data/internals/txEngine.ts`:

- `metadataPatch(id, skipMetadata)` new semantics:
  - **Always** advance `updated_at`, and make it locally monotonic
    (invariant I3): `max(this.ctx.now(), before.updatedAt + 1)` — every call
    site has `before` in scope. Without this, the server ratcheting ahead of a
    slow device clock makes a fresh local edit stamp *below* the row's current
    stamp, which under the new gate turns the next staging delivery into a
    disk revert and trips `BlockEditor`'s `lastAdoptedUpdatedAt` ratchet.
  - Bump `user_updated_at` + `updated_by` only when **NOT** `skipMetadata`
    (Q2 option A: `updated_by` is a user-pair field; the gate no longer reads
    it).
  - **[r2] Mint-sentinel hold:** for ids in `systemMintedIds` (the existing
    same-tx inheritance set, `txEngine.ts:220-228` / `authorFor`), keep
    `updated_at` at **0** for same-tx shaping writes. Every mint is
    create + same-tx `setProperty`/`update` shaping (stateBlocks, kernelPage,
    daily-note seats, shortcuts...), and the compactor fuses PUT+PATCH into one
    create — without the hold, the uploaded mint carries `updated_at = now` and
    the sentinel never exists. This repurposes the machinery that today
    inherits the `system:` author.
- `buildNewBlockRow`: normal creates set `updated_at = user_updated_at = now`.
  `systemMint` creates set **`updated_at = 0`**, `user_updated_at = now`,
  `updated_by = userId` (real user — no more `system:` stamping). **[r2] The
  `systemMint` opt is RETAINED** (r1 listed it for deletion while step 4
  depended on it — contradiction): it's now the "stamp 0" selector. Mint sites
  (`stateBlocks.ts` etc.) are unchanged — they already pass `systemMint: true`;
  stamps are set only in `buildNewBlockRow`, not at mint sites.
- **`applyRaw` (undo/redo, `txEngine.ts:622-692`) [r2]:** stamps only
  `updated_at`/`updated_by` today; it must also set `user_updated_at = now`
  (undo IS a user action), and its hand-written UPDATE column lists must gain
  the column. Undo of **pre-migration** `row_events` carries
  `userUpdatedAt: undefined` — fall back to the snapshot's `updatedAt`.
- **Every hand-written UPDATE column list** gains `user_updated_at`:
  `txEngine.ts:322` (delete), `:347` (restore), `:376` (update), `:426` (move),
  `:452` (setProperty), `:641`/`:677` (applyRaw).
- **Roam import** sets `updatedAt` directly from Roam edit-time
  (`plan.ts:277,539`, `import.ts:264`): set `user_updated_at` from the Roam
  edit-time (that's the display meaning) and let `updated_at` mirror it —
  creates don't participate in the monotonic ratchet, any later edit bumps past
  it.

### 5. Display/sort consumer repointing [r2 — r1's list was wrong in both directions]

**Move to `userUpdatedAt`** (display/recency semantics; with "always bump", a
rename's workspace-wide `references_json` reindex would otherwise flood these
with hundreds of untouched blocks):
- `src/data/internals/kernelQueries.ts:267` (FTS picker `ORDER BY updated_at DESC`),
  `:278` (`SELECT_RECENT_BLOCKS_SQL`), `:374` (fuzzy-rank input)
- `src/utils/fuzzyRank.ts:150-227` (recency boost)
- `src/plugins/find-replace/dataExtension.ts:90`
- `linkTargetAutocomplete.ts:180`
- `src/plugins/backlinks/`… `grouped-backlinks/query.ts:229,265`
- `propertyPanel/model.ts:252` ("Last changed" — would show 1970 for a
  0-stamped mint if left on `updated_at`)
- `recents/RecentsPageBlockRenderer.tsx:82`, `UpdateIndicator.tsx:28,36`,
  `BlockProperties.tsx:60,117`

**Must STAY on `updatedAt`** (version semantics — blind repointing breaks them):
- `BlockEditor.tsx:74-80,136-155` — the `lastAdoptedUpdatedAt` stale-write
  ratchet
- `src/hooks/block.ts:226-242` — `BlockContentRevision`
- `blockCache.ts` fingerprint/dedup and `applyIfNewer`
- the observer/gate, upload triggers, anything in `src/sync/`

(r1 listed `utils/copy.ts`, `utils/selection.ts`, `geo/query.ts`,
`spreadBlockDates.ts` — none of these read `updatedAt` at all.)

No code asserts `updated_at >= created_at` (Q1: verified, comments only) — the
0 sentinel is safe at the storage layer.

### 6. Reconcile gate simplification + cache layer

`src/sync/observer/reconcile.ts` + `materialize.ts` + `observer.ts` +
`invalidate.ts` + `blockCache.ts`:

- The gate becomes:
  ```
  if defer                                  -> defer
  if hasPendingUpload                       -> skip-stale  // un-uploaded local edit wins
  if local != null && local === staging
                   && local !== 0           -> skip-stale  // equal nonzero ⟺ identical content (I1)
  else                                      -> apply       // newer server truth, or 0-stamp yield (I2)
  ```
  **[r2] The stamp-0 exemption is required, not optional.** Without it, two
  devices that both mint the same deterministic id sit at 0 === 0 → equal-stamp
  skip → the insert-or-skip loser **never converges** to the server's
  `created_at`/`created_by`/`user_updated_at` — and not even to content, if an
  app update changed the default template between the mints. r1's "equal ⟺
  identical content (now provable)" claim is false at exactly the stamp it
  introduced; with the exemption it holds for all stamps the invariant covers
  (> 0).
- **Delete:** `ReconcileMode` (`strict`/`healing`), `LocalRowState.isOwnSystemMint`,
  the provenance branch, `healWorkspace` + the healing path of
  `Repo.scheduleReconcileRescan`. The strictly-newer-local protection is gone:
  a genuinely-newer local edit is either pending (caught above) or acked — and
  an acked edit's echo re-asserts it (PowerSync write-checkpoint), so the only
  cost is a transient revert in rescan paths (`drainWorkspace`) during the
  ack-to-echo window. Steady-state queue-driven drains can't even hit it (the
  pre-edit staging row was already consumed; the next delivery for that id IS
  the echo).
- **Retire `system:` via a one-time migration [r2 + user-requested], not by
  carrying it forever.** r1 (and the first r2 pass) proposed keeping
  `systemAuthor`/`isSystemAuthor` indefinitely because historical rows keep
  `system:<uid>` in `updated_by`. Cleaner: a one-time server migration converts
  every remaining `system:` row to the new pristine representation (the
  post-upgrade `system:` cleanup in step 7) — set `updated_at = 0` (the new
  pristine signal,
  which also *heals shadows*: the 0-stamped server row re-replicates and every
  client applies it via the stamp-0 exemption) and rewrite `updated_by` from
  `system:<uid>` back to `<uid>`. A remaining `system:` row is provably
  pristine — a real edit self-clears the author — so this is safe. After it
  runs, the new pristine signal is purely `updated_at === 0`; the
  `UpdateIndicator` suppresses on that, and `globalState.ts:108`/`:` "System"
  rendering and `isSystemAuthor` can be **deleted** from live paths.
  - **Caveat:** historical `row_events`/`blocks_history` snapshots still carry
    `system:<uid>` strings (we don't rewrite audit history). So keep
    `isSystemAuthor` as a *pure display fallback* for time-travel/undo of a
    pre-migration snapshot (an undo restoring `updated_by = system:<uid>` should
    still render sanely), but stop using it for the gate and for live mint
    stamping. "Delete from live paths, keep as a history-display shim" — not a
    full delete.
- **Cache layer [r2 — r1 had no plan here]:** keep `applyFromSync` (the
  before-matching force heal, `blockCache.ts:206-219`) and make the
  `forceHeal` parameter of `applySyncInvalidation` unconditional (it was
  `gateMode === 'strict'`, a mode that no longer exists). Rationale — "cache
  follows disk": every row the disk gate applies force-heals the live cache
  when the cache matches the pre-write row. This (a) heals shadows in-session
  (server row > 0 also passes plain `applyIfNewer`, so the force path is
  belt-and-suspenders there), (b) lets the rare rescan-window replay revert
  flicker through and converge on the echo, and (c) correctly rolls back a
  **permanently-rejected** edit (quarantined in `ps_crud_rejected`, no echo
  ever coming): without the force path, disk converges to the server while the
  cache pins the rejected edit's newer stamp and every hydrate
  (`repo.ts:706,1114` `applyIfNewer 'hydrate'`) rejects the disk row until
  reload. Showing a rejected edit forever is a lie; the sync-status plugin is
  the surface for "this change couldn't sync."
- Comment updates: `429fd4b2`'s equal-stamp rationale (now "equal nonzero ⟺
  identical server content; same-ms local optimistic writes still collide"),
  and `materialize.ts:54-58`'s "a row that reaches this write always differs"
  (still true — stamp differs at minimum — but re-derive it).
- **QuickFind-freeze canary** (`src/data/internals/invalidation.test.ts:645`):
  its premise ("LWW-rejected delivery does not invalidate handles") changes —
  the old strictly-newer rejection now applies. Replace with: (a) a rescan
  during the ack-to-echo window may transiently apply the older row but the
  echo converges disk+cache within the same settle, and (b) no repeated
  handle-wake loop (the freeze signature). Do NOT delete it without these.

### 7. Recovery

**Discovery (server-side, primary) [r2]:** the stale rows are enumerable from
`blocks_history` — content changed without a stamp change:

```sql
SELECT DISTINCT block_id FROM blocks_history
WHERE op = 'U'
  AND NOT (changed_columns @> ARRAY['updated_at'])
  AND changed_columns && ARRAY['content','properties_json','references_json',
                               'parent_id','order_key','deleted'];
```

Caveat: history exists since 2026-05-22; if Layout-B-era staleness predates it,
fall back to the full touch. The client-side diff (`blocks_synced` vs `blocks`
on content columns where the local stamp is ≥ staging) remains useful as a
per-device before/after measurement.

**Recovery touch (scoped):** `UPDATE blocks SET updated_at = updated_at + 1
WHERE id IN (<discovered ids>)` — bracketed by the same
`DISABLE TRIGGER blocks_record_history_trg` as the backfill. The trigger floor
preserves the +1 (no content change → no extra bump). Every touched row
re-replicates as strictly-newer → every client applies → converged.

**Why scoped, not all-rows [r2]:** a full touch re-replicates the entire
dataset and the client cost is real — full re-download into staging, full
re-materialization through the derived-index triggers (FTS/alias/types), and
one `row_events` row per block with no pruning (`clientSchema.ts:61` —
"retention is a future opt-in"); on the 320k-block workspace that already
froze a client once, that's a doubled `row_events` table and hours of drain
churn. Scope first; full touch only as the fallback.

**Pre-checks before the touch [r2]:**
- every device's `ps_crud` drained (the rollout already requires this), and
- `SELECT count(*) FROM ps_crud_rejected` is zero (or triaged) per device —
  a quarantined-rejected edit is content-newer locally but NOT pending, so the
  touch makes the server overwrite it everywhere; the only surviving copy is
  the quarantine envelope. That clobber is the *correct* end-state for a
  permanently-rejected write, but it must be a decision, not a surprise.

**One-time `system:` cleanup [user-requested; r3 Codex P1 — runs HERE, not in
the step-1 migration].** Run once after the fleet is fully on the new bundle
(new clients mint pristine rows at `updated_at = 0` directly, so no nonzero
`system:` rows are being created anymore — running it earlier would strand rows
minted by not-yet-upgraded old clients):

```sql
ALTER TABLE public.blocks DISABLE TRIGGER blocks_clamp_updated_at_trg;
ALTER TABLE public.blocks DISABLE TRIGGER blocks_record_history_trg;
UPDATE blocks
   SET user_updated_at = COALESCE(user_updated_at, updated_at),  -- keep display stamp BEFORE zeroing
       updated_at      = 0,                                      -- pristine sentinel; re-replicates + heals shadows
       updated_by      = substring(updated_by from length('system:') + 1)
 WHERE updated_by LIKE 'system:%';
ALTER TABLE public.blocks ENABLE TRIGGER blocks_record_history_trg;
ALTER TABLE public.blocks ENABLE TRIGGER blocks_clamp_updated_at_trg;
```

**The clamp/floor trigger MUST be disabled for this UPDATE** — otherwise the
floor `greatest(NEW.updated_at, OLD.updated_at)` pins `updated_at` back to `OLD`
and the `= 0` never lands. (The one place we deliberately push a stamp *down*;
every other path is forbidden from doing so, which is why the trigger must be
off.) **`user_updated_at` is set in the same SET list, before zeroing [r3 Codex
P2]** — so display/sort consumers that move to `user_updated_at` show the real
last-edit time, not the 0 sentinel; the step-1 backfill's `WHERE
user_updated_at IS NULL` then no-ops for these rows regardless of order. Safe
because a row still authored `system:<uid>` is provably pristine (a real edit
self-clears the author). On re-replication each client applies the 0-stamped row
via the gate's stamp-0 exemption, converging shadows to server truth — so this
subsumes shadow recovery for these rows. Audit history
(`row_events`/`blocks_history`) is intentionally NOT rewritten; the
`isSystemAuthor` display shim (step 6) covers time-travel over those rows.

### Rollout sequence (strict order) [r2]

1. **Supabase migration** (column nullable + trigger COALESCE/floor/bump + RPC
   column + backfill-with-trigger-disabled). Old clients keep working: their
   PUTs get `user_updated_at` populated by the trigger; their PATCHes never
   carry the column (server value survives); their literal `updated_at` patches
   get floored, never regressed.
2. **PowerSync sync-rules deploy** (`yarn gen:sync-config` + `powersync` skill).
   Must follow the migration (rules reference the column) and precede the
   client bundle. Note the redeploy itself re-processes buckets (full
   re-download) — it does NOT substitute for the touch (stamps unchanged →
   gates still skip).
3. **Drain each device** (`ps_crud` empty; check `ps_crud_rejected` while
   there), then **ship the client bundle**.
4. **Confirm the fleet is fully upgraded** (no device still on the old bundle —
   otherwise it can still mint nonzero `system:` rows), then **recovery touch**
   (scoped; pre-checks above) **and the one-time `system:` cleanup** (above).
   Both run in this last phase; the `system:` cleanup specifically requires "no
   old clients left minting" (r3 Codex P1).

**Known mixed-window artifact — old-client edits show a stale "last edited"
(Codex P2, accepted as bounded).** While a device is still on the old bundle, a
genuine user edit bumps `updated_at` (new edit time) but carries no
`user_updated_at`; the trigger's `COALESCE(NEW.user_updated_at, NEW.updated_at)`
fires only when the value is NULL, so for an *existing* row it leaves
`OLD.user_updated_at` in place. Once new clients repoint display to
`user_updated_at` (step 5), such an edit displays/sorts at the *previous* edit
time until the device upgrades or the block is next edited from a new client.

Codex's proposed trigger heuristic ("key off metadata changes old skipMetadata
writes don't make") **does not work** and the doc should not adopt it: at the
server, an old-client *user edit* (content+, `updated_at`+, `user_updated_at`
absent) is indistinguishable from a new-client *skipMetadata* write (content+,
`updated_at`+, `user_updated_at` absent) — and `updated_by` is not a reliable
discriminator because consecutive edits by the same author don't change it. No
trigger-only rule separates them. Two honest mitigations, implementer's choice:
  - **(a) Accept it.** Bounded to the mixed-version window (minutes–hours per the
    drain-then-swap playbook, 2 users / 5 devices), display-only, self-corrects
    on the next new-client edit. Recommended — the cost is trivial at this fleet
    size.
  - **(b) Defer the display repoint.** Ship the new bundle still reading
    `updated_at` for display, flip to `user_updated_at` in a *second* bundle once
    the fleet is fully upgraded. Eliminates the artifact entirely, at the cost of
    a two-phase client ship (and during the window, new-client bookkeeping writes
    would float blocks in recency instead — the symmetric trade). Only worth it
    if "last edited" precision during the window matters.

---

## Open questions for the implementer (much smaller than r1)

**Q-A — NOT NULL tightening:** ship nullable + trigger-population forever, or
add a later migration tightening to NOT NULL once the fleet is upgraded?
Either is sound; nullable-forever is less ceremony, NOT NULL documents the
invariant in the schema. Implementer's call.

**Q-B — `user_updated_by`:** Q2 resolved as option A (`updated_by` frozen with
`user_updated_at` on skipMetadata; no new author column; the gate no longer
reads authorship). Revisit only if a consumer of storage-level "who wrote this
row last, including bookkeeping" turns up — none known.

**Q-C — pre-history staleness:** if the discovery query comes back suspiciously
small, decide whether Layout-B cutover predates `blocks_history` (2026-05-22)
for the affected workspaces and the full touch is needed after all.

---

## Code map

- `src/sync/observer/reconcile.ts` — `decideStagingRow` (simplify + stamp-0 exemption).
- `src/sync/observer/materialize.ts` — `LocalRowState` build, Phase 1/2 gate calls.
- `src/sync/observer/observer.ts` — drop `healWorkspace`/gateMode; `applyOutcome` forceHeal.
- `src/sync/observer/invalidate.ts` — `applySyncInvalidation` (forceHeal unconditional).
- `src/data/blockCache.ts` — `applyIfNewer`, `applyFromSync` (retained, see step 6).
- `src/data/internals/txEngine.ts` — `metadataPatch`, `buildNewBlockRow`,
  `applyRaw`, `systemMintedIds`, all hand-written UPDATE column lists.
- `src/data/internals/clientSchema.ts` — `BLOCK_UPLOAD_COLUMNS`, upload triggers,
  `blockJsonObjectSql` (row_events projection).
- `src/data/blockSchema.ts` — `BLOCK_STORAGE_COLUMNS`, `parseBlockRow` (fallback),
  `BLOCK_SNAPSHOT_JSON_FIELDS`, `blockToRowParams`, raw-table defs.
- `src/data/workspaceSchema.ts:74-83` — `ensureWorkspaceE2eeColumns`, the local
  ALTER-TABLE pattern to copy.
- `src/data/api/user.ts` — `systemAuthor`/`isSystemAuthor` (RETAINED; mint-path
  author stamping retired).
- `src/data/stateBlocks.ts` — mint sites (unchanged; stamps live in
  `buildNewBlockRow`).
- `src/data/repo.ts` — `scheduleReconcileRescan` (healing variant gone), `:1747`.
- `src/services/powersync.ts` — `applyBlockCreates` (insert-or-skip),
  `applyBlockPatchesRpc`, `compactBlockCrudEntries`, `uploadErrorClassifier`.
- `supabase/migrations/20260510222352_consolidated_initial.sql:168` — clamp trigger.
- `supabase/migrations/20260527180103_add_apply_block_patches_rpc.sql:55-67` — RPC UPDATE.
- `supabase/migrations/20260522062437_add_blocks_history.sql:167-170` — history trigger.
- `docs/deterministic-id-shadow-handoff.md` — why `system:<userId>` existed.
- `docs/field-level-sync-merge.md` — on-hold doc; clamp-bypass GUC cross-ref.
- `src/data/internals/invalidation.test.ts:645` — the canary (replace per step 6).

## Verification

`yarn run check`. Plus: pgTAP for floor/bump/COALESCE/RPC-passthrough (step 1,
incl. the e2ee fresh-nonce caveat); client tests for the split (`metadataPatch`
monotonic + skipMetadata advances `updated_at` not `user_updated_at`; mint-tx
sentinel hold survives same-tx shaping + compaction; stamp-0 row yields to a
0-stamped server row); a two-client test that a skipMetadata refs write on A
lands on B; updated reconcile tests (delete mode/provenance cases; add
older-stamp-applies and stamp-0-exemption cases); the canary replacement pair;
local ALTER-TABLE migration test against a pre-split DB fixture.
