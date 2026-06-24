# Correctness audit — 2026-06-18

Coreness-prioritized correctness audit of the data kernel, sync/crypto, reference
projection, and data-write plugins. Method: per-area **map → bug-hunt → adversarial
verify** (2 independent skeptics per finding, defaulting to *refute*), plus **randomized
fuzzing** of the pure functions. 16 areas, 68 raw findings → **18 confirmed**, **34
refuted/guarded/by-design**, plus a low-severity backlog. 1 fuzz failure.

Status legend: **confirmed** = ≥1 verifier independently reproduced it and none refuted;
**refuted** = a guard / unreachability / intended-design was found (cited). Many confirmed
findings were also reproduced by throwaway probe tests during the hunt.

---

## Confirmed findings (prioritized: coreness × severity)

### A. Core kernel (tier 1)

**A1 — Tied `order_key` siblings make Enter-split / reorder / outdent throw and silently drop the edit** · HIGH · confirmed (probe)
`src/data/mutators.ts:95,99,396,531,685` · `src/data/orderKey.ts`
Two siblings sharing an `order_key` is an explicitly *supported* on-disk state (non-unique
`(parent_id, order_key, id)` index, `src/data/blockSchema.ts:97-99`; residual jitter
collisions resolved by the `(order_key,id)` secondary sort, `orderKey.ts:5-8`; arrives via
import / concurrent sync / `setOrderKey`). But `keyBetween(equal, equal)` throws `"X >= Y"`
(`fractional-indexing-jittered`), rolling back the whole tx. 5 of 6 structural ops break
(`createSiblingBelow/Above`, `split`, `insertChildren` before/after); only `moveVertical`'s
adjacent-swap dodges it. The Enter handler (`defaultShortcuts.ts:630-701`) has no try/catch,
so **Enter-to-split on a tied block loses the text typed at the cursor** (the suffix is
dispatched to the editor before `split` throws → editor/SQL divergence).
*Fix:* equal-bounds re-key fallback in `orderKeyForInsert`/`split`/`outdent`/`insertChildren`
(compute against the next *distinct* neighbor, or re-key the tied run). **Missing test (A1b,
confirmed):** no mutator-level test ever places the engine in the tied state.

**A2 — `move()` cycle guard is bypassed by a soft-deleted intermediate → durable structural cycle** · HIGH · confirmed (probe, 2 verifiers)
`src/data/internals/txEngine.ts:406-418` · `src/data/internals/treeQueries.ts:119-137`
`IS_DESCENDANT_OF_SQL` filters `deleted=0` in both the base case (`:125`) and every hop
(`:132`). With tree `root→A→B→C`, soft-delete `B`, then `move(A under C)`: the ancestor walk
from `C` hits `B(deleted)` and stops, never reaching `A` → `hit=null` → move proceeds,
creating cycle `A→C→B→A`. `requireParentInWorkspace` has no deleted filter; `restore()` runs
no cycle check (restoring `B` exposes a live 3-cycle); the `cycleScanSql` telemetry shares
the same `deleted=0` blind spot. The corrupt `parent_id` **uploads and propagates
fleet-wide**. Reproduced byte-for-byte by probe. Dominant real-world trigger is concurrent
sync (one device deletes `B` while another moves `A`).
*Fix:* the descendant walk must traverse `parent_id` regardless of `deleted` — cycle-freedom
is structural, independent of soft-delete.

**A3 — Self-merge silently corrupts the block (tombstone + doubled content + orphaned children)** · HIGH (latent) · confirmed mechanism; reachability-gated
`src/data/blockMerge.ts:49-65` · `src/data/mutators.ts:723`
`core.merge({intoId:x, fromId:x})`: `tx.delete(x)` writes an `after=tombstone` snapshot, then
`tx.update(x,…)` reads that tombstone via `requireExisting` (no `deleted` filter, no throw)
and writes content `x.content+x.content` while the row stays `deleted=1`; children re-home
under the tombstone. Probe: `deleted=TRUE, content="foofoo"`, child orphaned.
**Adversarial verify downgraded this from "live critical" to "latent high":** every *current*
caller already excludes self (`MergePicker` `excludeBlockIds:[sourceBlockId]`; alias path
`claimant.id===plan.id→continue`; backspace `previousVisibleBlock` never returns current). But
`core.merge` is a **public mutator** (agent bridge / macros / plugins) with **no guard**.
*Fix:* one line — `if (intoId === fromId) return` in `mergeBlocksInTx`.

**A4 — Latent cross-client alias dup wedges ALL property edits + restore of the affected block** · HIGH · confirmed (sqlite repro, 2 verifiers)
`src/data/internals/clientSchema.ts:762-772, 821-840`
The alias-uniqueness trigger is source-gated OFF for sync (`:824 WHEN source IS NOT NULL`), so
two synced blocks `X`,`Y` in one workspace can both hold alias `foo` (documented intended-
until-V2). Any later *local* edit touching `X`'s `properties_json` runs
`blocks_alias_update` → `DELETE`+re-`INSERT` `X`'s aliases → the re-insert fires the
uniqueness trigger (local ⇒ source set), sees `Y` still claims `foo` → `RAISE(ABORT)` → the
**entire user tx rolls back**. The block becomes uneditable (every property/type/alias edit
fails) and **un-restorable** while `Y` lives. Content-only text edits survive (don't fire
`alias_update`).
*Fix:* make the local re-insert tolerate a pre-existing cross-client claim (self-reclaim
should also cover *another* block's claim), or reconcile dup aliases on materialization.

**A5 — Cross-workspace undo: cmd-Z reverts/uploads an edit in an unopened workspace** · MEDIUM · confirmed (2 verifiers)
`src/data/internals/undoManager.ts:52` · `src/data/repo.ts:971,988` · `WorkspaceSwitcher.tsx:60-66`
Undo stacks are keyed only by `ChangeScope` (`UndoEntry` has no `workspaceId`); workspace
switch is in-place (no reload, no `undoManager.clear()`). After editing in A then switching to
B, `cmd-Z` (global action) pops the A entry and `_replay` pins the write to A's `workspaceId`
— you mutate + upload an edit in a workspace you're not looking at (violates the project
"don't touch unopened workspaces" rule). **A5b (confirmed):** if B is viewer-role,
`repo.setReadOnly(true)` makes that same `cmd-Z` spuriously `ReadOnlyError` on your editable-A
entry — you can't undo legitimate A edits while viewing B.
*Fix:* key undo entries by workspace and scope undo/redo to the active workspace (or clear on
switch).

**A6 — Same-tx field processors re-run during undo/redo replay (no replay-skip gate)** · MEDIUM (latent) · confirmed (probe)
`src/data/internals/commitPipeline.ts:277-300` · `src/data/repo.ts:_replay`
`applyRaw` is documented to drive a row to *exactly* the restored state, but the post-fn
same-tx pass runs on the replay tx too and re-derives. Proven to corrupt with a deliberately
non-idempotent processor (`'orig'` → undo → `'orig!'`). No live production processor derives
non-idempotently today (`normalizeReferences`/alias-sync are idempotent), so no current data
loss — but the replay contract has a hole any future value-deriving same-tx processor falls
into.
*Fix:* skip the same-tx pass on `_replay` (or run `applyRaw` outside it), and pin the
invariant with a test.

**A7 — Merge-into-descendant throws `CycleError`; the alias-collision "Merge" button gets permanently stuck** · MEDIUM · confirmed (2 verifiers)
`src/data/blockMerge.ts:51-56` · `src/plugins/alias/AliasCollisionToast.tsx:68`
`mergeBlocksInTx` re-homes `from`'s children under `into`; if `into` is inside `from`'s
subtree, `tx.move` trips the cycle guard → `CycleError` → clean rollback (no corruption) but
the merge can never succeed. The alias-collision toast drives this automatically with
`intoId=conflictingBlockId, fromId=attemptedOn`; for a nested aliased-page rename the catch
surfaces the raw error and re-enables the button → **every retry fails identically**.
*Fix:* pre-check ancestry and emit a typed, actionable precondition (or swap direction)
instead of a raw `CycleError`.

### B. Sync / crypto (tier 2)

**B1 — One malformed element in a `refList` silently deletes ALL of a field's backlinks** · HIGH · confirmed (probe, 2 verifiers)
`src/data/api/codecs.ts:170-173` · `src/plugins/references/referenceProjection.ts:34-52` · `referencesProcessor.ts:188`
`refList.decode` does `j.map(stringCodec.decode)`; one non-string element throws the whole
`map` → `projectPropertyReferences` catches → contributes nothing → the processor *replaces*
the references column. `['valid-1','valid-2',42]` → `[]` (both valid backlinks lost) on the
next unrelated content edit. `setProperty` doesn't validate on write, so a buggy plugin /
schema skew / cross-device sync plants it; the strip then **propagates cross-device**. Same
structural class as the historical ~10k `next-review-date` wipe (but for *present*-schema
fields, which the `retainedAbsentRefs` guard doesn't cover).
*Fix:* decode element-wise and drop only the bad element; never let a present-schema ref
field strip to `[]`.

**B2 — PostgREST errors carry no `status`, so the 4xx-permanent branch is dead → queue jams forever** · HIGH · confirmed (vs SDK source, 2 verifiers)
`src/services/powersync.ts:318,333,353` · `src/services/uploadErrorClassifier.ts:52-54`
`PostgrestError` exposes only `{message,details,hint,code}`; HTTP `status` is a sibling of the
response tuple, dropped when the upload sinks `throw error`. The classifier's `err.status`
4xx branch is therefore **dead**; an unrecognized permanent 4xx with no `code` (401/403, 413,
generic 400, or any non-JSON error body → `{message: body}`) falls through to `transient` →
PowerSync retries the same batch forever → the upload queue jams. (Code-based classification
at `uploadErrorClassifier.ts:38` still catches known codes like `23xxx`, so only codeless /
status-only errors jam.) The existing test builds synthetic errors *with* `.status`, a shape
production never produces — false confidence.
*Fix:* thread the HTTP status through the throw (`throw Object.assign(error, {status})`) and
classify on it.

**B3 — Throw after the committed sync write but before the watermark delete permanently drops that window's invalidation** · MEDIUM · confirmed (2 verifiers)
`src/data/internals/syncObserver/observer.ts:178-215` · `invalidation.ts:67`
`collectPluginInvalidationsFromSnapshots` iterates plugin `InvalidationRule`s (a live
extension point) with **no try/catch**. A throwing rule propagates out of `applyWindow`
*after* the blocks rows are committed and the cache is written but *before* the
`blocks_synced_changes` watermark `DELETE`. On retry the disk gate skip-stales the now-equal
stamp, so `handleStore.invalidate` never fires for those ids → query handles stay stale until
an unrelated change or a reload. Disk is correct; only the notification is lost.
*Fix:* wrap the plugin-rule loop in try/catch (isolate per rule), or advance the watermark
only after invalidation succeeds.

**B4 — Workspace-key paste tolerance gap** · LOW · confirmed
`src/sync/crypto/base32.ts:17-23` · `src/sync/keys/workspaceKey.ts:35`
A WK paste with internal whitespace/newline (line-wrapped paste, printed backup) throws
`base32: invalid input`; only the outer string is trimmed. A valid backup looks corrupt →
recovery-UX failure (no data loss).
*Fix:* strip internal whitespace before base32-decode.

**B5 — Empty-plaintext envelope boundary untested** · LOW · confirmed (missing-test)
`src/sync/crypto/envelope.ts`
Empty content seals to exactly the 28-byte floor (`NONCE_BYTES+GCM_TAG_BYTES`); the floor is
`< 28` so it passes, but no test pins it. A future off-by-one (`<= 28`) would quarantine every
empty block on download.
*Fix:* add `seal('') → open === ''` round-trip + a `decodeEnvelope` truncation test.

### C. Data-write plugins (tier 4)

**C1 — SRS scrub-shift diverges the stored interval from the realized due date → corrupts interval + snapshot-history** · HIGH · confirmed (traced, 2 verifiers)
`src/plugins/srs-rescheduling/index.ts:366-377, 198-206, 284-310`
`shiftPlanDate` moves the next-review date but leaves `newInterval` unchanged; commit writes
the unshifted interval + the shifted date + a snapshot recording the wrong interval. Regrading
a shifted draft compounds it (`basisFromPlan` uses unshifted interval but shifted
`scheduleFrom`): `interval=40` stored against a realized 50-day gap. Permanently corrupts
snapshot-history and the SM-2.5 curve drifts off the real schedule. **C1b (confirmed):** no
test pins interval/date consistency after a `shiftDate`.
*Fix:* recompute interval from the shifted date (or pin the intended decoupling), and add the
consistency test.

**C2 — Placeholder restore blanks a tombstoned real content block** · MEDIUM · data-loss · confirmed (2 verifiers)
`src/plugins/roam-import/import.ts:1106-1135`
If a real imported block was user-deleted, and a later export references its uid only as
`((uid))` without including the real block, `ensurePlaceholderRow` hits `DeletedConflictError`
and `tx.restore(id, {content:'', references:[], properties:{}})` + move-to-root resurrects it
as an **empty stub**, destroying prior content/properties/backlinks. Narrow ordering
dependency, but conflicts with "preserving live user data including history is paramount."
*Fix:* don't blank-restore a tombstone that holds real content; create a distinct placeholder
id, or skip restore when the existing row has content.

### Fuzz failure

**F1 — `mergeProperties` array dedup is key-order-sensitive and value-lossy** · MEDIUM (reachability-gated) · fuzz-confirmed
`src/data/mergeProperties.ts:42-57`
Dedups list items by `JSON.stringify(item)`: `[{id:'x',alias:'A'}]` ∪ `[{alias:'A',id:'x'}]`
→ **2 entries** (should be 1); `[NaN]` ∪ `[null]` → **1 entry** (both stringify `"null"`, a
distinct value dropped). Only bites `unsafeIdentity` object-lists with divergent key order
(SRS snapshots, user "Options" lists) — the built-in ref/refList/list(string) codecs are
string-valued and immune.
*Fix:* canonicalize with sorted keys + value-distinguishing encoding (`stableJsonValue`
already exists in `txEngine` and is used by `jsonValuesEqual`).

---

## Notable refutations (don't chase these — a guard/reason was found)

- **Plaintext leak for a server-e2ee workspace (`ps-edge-2`)** — *refuted.* `encryption_mode`
  is set at workspace creation and made immutable (`workspaces_prevent_e2ee_field_change`), so
  there is no "converted-to-e2ee stale pin"; a server-e2ee workspace with a non-e2ee pin
  resolves to `locked:key-required` and the editor never mounts → no upload. Fail-closed gating
  is sound.
- **`encryptUploadColumns` fail-open on non-string column (`transform-1`)** — *refuted as
  reachable.* The upload triggers emit content columns as bare `NEW.<col>` over TEXT columns
  (no `json()` wrap on the upload path), so the value is always a JSON string. Latent only;
  a fail-*closed* throw would still be a cheap hardening.
- **Importer "silently" strips absent-schema refs (`roam-1`)** — *refuted as silent
  data-loss.* The only sourceField refs the importer writes are SRS `next-review-date`, coupled
  to `addTypeInTx(SRS_SM25_TYPE)`; with SRS toggled off the import **crashes loudly**
  (`[addType] type … not registered`) before it can strip-and-write. Still worth making the
  importer reference-rebuild add-only (defense in depth), but it is not the silent incident.
- **Undo replay untested with references processors (`undo-2`) / importer ref preservation
  (`roam-6`) / `mergeImportedProperties` drop (`roam-3`)** — *refuted:* tests exist
  (`referencesProcessor.test.ts`, `import.test.ts:1654-1663`, `import.test.ts:375-392`).
- **No key rotation / nonce-reuse budget (`aead-1`)** — *refuted:* the e2ee design doc
  explicitly quantifies and accepts the random-96-bit birthday bound.
- **Reschedule has no liveness guard (`srs-3`)** — *refuted:* archived cards are excluded from
  the deck (`dueQuery.ts:63`).
- **`normalizeReferences` SPACE separator collision (`refproj-1`)** — *refuted as reachable:*
  property refs have `alias===id` and the real keys don't align without adversarial
  space-bearing ids; switching to the NUL escape is still the right consistency fix.
- **Re-import clobbers Roam edit-time (`roam-2`)** — *refuted as a bug:* deliberate documented
  tradeoff (don't re-source so a re-import can't clobber a real local edit).
- Also refuted/guarded: `keys-1` (quarantine has no consumer ⇒ behaves like defer), `keys-2`
  (gate unmounts, the in-session paste surface is gone), `observer-2`/`reconcile-1` (covered /
  server-monotonicity-clamped), `area-1`/`area-2` (production wiring filters), `ps-edge-3`
  (recordRejection has no payload-driven failure mode), plus run-2 `repo-1`, `qh-1`, `merge-2`,
  etc.

## Verified clean (fuzz + adversarial trace)

`orderKey` monotonicity & degenerate bounds · `base32`/`base64url`/`envelope` round-trip &
malformed rejection · **AEAD AAD-binding** (ciphertext cannot be moved between
columns/blocks/workspaces; tamper rejected) · value-codec round-trip · `panelLayoutProjection`
no-drop · `handleStore` batch/GC/mid-load/deferred-stale invariants · reprojection *core* is
genuinely add-only · SRS timezone/DST scheduling (the UTC reinterpretation cancels in every
TZ).

## Low-severity backlog (hunter-found, not independently verified)

`orderedBlockUpserts` unbounded recursion → stack-overflow jam on pathological deep import
(`powersync.ts:265`) · 6-digit sibling pad inverts order at ≥1M children
(`roam-import/plan.ts:310`) · `update({properties})` replaces the whole map (footgun;
`setProperty` is the merge-safe path) · `isRefCodec`/`isRefListCodec` classify by the open
`type` string alone · `date.where.encode` accepts garbage → wrong SQL date bound silently ·
`getBlockTypes` throws on a non-array `types` value · `row_events.created_at` ms-granularity
ties · `structuralEditPolicyForBlock` permissive for a null/detached block · several
missing-test items on `reprojectRefTypedProperties` / `projectorRuntime`.

## Recommended fix order

1. **A1** (tied order_key — broadest user-facing edit-loss) + **A1b** test
2. **A2** (move cycle bypass — fleet-wide structural corruption)
3. **A3** (self-merge guard — one line) + **B1** (refList element-wise decode) — both small, both data-loss class
4. **A4** (alias-dup wedge) + **A5** (cross-workspace undo)
5. **B2** (thread HTTP status — queue-jam) + **B3** (isolate plugin invalidation rules)
6. **C1** (SRS interval/date) + **C2** (placeholder blank-restore) + **F1** (`mergeProperties` canonical dedup)
