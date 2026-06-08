# Sync-queue flood + unsealed e2ee PATCH — investigation handoff

> **⚠️ See "Update (session 2)" near the bottom for the verified root cause.**
> Two hypotheses in the original writeup are now corrected: (1) Issue A is *not*
> "pre-existing / NOT e2ee-specific" in the way that matters — it was latent but
> the **Layout B cutover bundled into the merge is what makes it fire every
> reload**; (2) the "`alias === id` guarantees a diff" theory is wrong — both
> projection paths write `alias === id`. A **third** problem was also found: the
> queue isn't draining because the oversized PATCH RPC hits a Postgres
> **statement timeout** and retries forever (Issue C).

**Found:** 2026-06-08, while manually testing the merged e2ee groundwork (PR #105)
on live profile `ff-vlad-dev` (user `vlad@sitalo.org`, workspaces: `stvad`
plaintext + `e2eet1` e2ee).

**Symptom that kicked this off:** after a reload (pulling e2ee workspace
changes), the sync widget showed **~16,280 blocks "queued for upload"** and the
queue **was not draining**, plus **one rejected sync change**. Initial worry was
that the e2ee work had mutated the existing plaintext workspace's blocks.

**Bottom line:** there are **two independent bugs**, neither of which corrupts
your content (content/properties are intact; only the derived `references_json`
backlinks are churned). But together they flood the upload queue on every load.

- **Issue A (primary, pre-existing, NOT e2ee-specific):** the ref-typed-property
  **reprojection re-runs on every cold-start** and rewrites ~16k blocks'
  `references_json`, because its "already backfilled" marker gate is failing.
  This re-queues ~16k PATCHes every reload → the queue never drains.
- **Issue B (e2ee-specific, from PR #105):** at least one PATCH for a block in
  the **e2ee** workspace goes up **unsealed** (plaintext `properties_json`, and
  the PATCH is **missing `workspace_id`**), so the server's
  `blocks_require_ciphertext_for_e2ee` trigger rejects it (code 23514). This is
  the "1 rejected sync change." Fail-closed (no plaintext persisted server-side),
  but it's a stuck rejected item and a real encrypt-on-upload gap.

This was **NOT triggered by e2ee workspace creation specifically** — see the
metrics under Issue A: reprojection ran again on a plain reload (no new workspace
created that session) and rewrote 16,264 blocks. Creating the e2ee workspace just
involved a reload, which is when it was noticed.

---

## How to reproduce / inspect (agent bridge)

All evidence below came from the live client via the agent CLI:

```
yarn agent --profile ff-vlad-dev ping                 # confirm connected
yarn agent --profile ff-vlad-dev sql all "<SQL>"      # run SQL in the tab
yarn agent --profile ff-vlad-dev eval "return <js>"   # run JS (repo/db in scope)
```

(SQLite JSON paths use `'$.x'`; in zsh escape the `$` as `\$` inside double
quotes.)

---

## Issue A — reprojection re-runs every cold-start (the queue flood)

### Evidence

`repo.metrics().reprojection`, captured **after a plain reload** (no workspace
created that session):

```json
{ "calls": 2, "schemasReprojected": 83, "rowsScanned": 16278,
  "blocksUpdated": 16264, "msTotal": 76960, "skippedByMarker": 3 }
```

- It rewrote **16,264 blocks** and spent **77 s** — on a normal reload.
- `skippedByMarker: 3` while **86** markers exist:
  `SELECT COUNT(*) FROM client_schema_state WHERE key LIKE 'reproject_ref:%'`
  → 86. So the marker gate is almost entirely ineffective.

Upload queue (persists across reload):

```
SELECT COUNT(*) rows, COUNT(DISTINCT json_extract(data,'$.id')) blocks FROM ps_crud;
-- rows 34227, blocks 16273  (~2.1 crud rows per block)

SELECT je.key col, COUNT(*) n
FROM ps_crud, json_each(json_extract(ps_crud.data,'$.data')) je
GROUP BY je.key ORDER BY n DESC;
-- references_json 34214, then a tiny tail (updated_at 22, properties_json 21,
--   content 8, workspace_id 8, ...) = the 8 full PUTs + a few genuine edits.
```

So the flood is **`references_json`-only PATCHes**. Workspace split:

```
SELECT b.workspace_id, w.name, w.encryption_mode, COUNT(DISTINCT b.id) queued
FROM blocks b JOIN ps_crud c ON b.id = json_extract(c.data,'$.id')
LEFT JOIN workspaces w ON w.id = b.workspace_id GROUP BY b.workspace_id;
-- stvad (none): 16265   |   e2eet1 (e2ee): 8
```

The rewritten references are projected from imported Roam ref-typed properties
(`sourceField` = `roam:isa` / `roam:author` / `roam:initial review date` / …),
and many flip to/from `[]`. The referenced-block `alias` is often **the raw id**
(unresolved), e.g. `{"id":"f208…","alias":"f208…","sourceField":"roam:isa"}`.

### Root-cause locus

`reprojectRefTypedProperties` in [`src/data/repo.ts`](src/data/repo.ts) (~1563–1742).

The marker gate (filter + write-back):

```
// filter (skip names already backfilled AND still ref-typed):
const kind = refCodecKind(propertySchemas.get(name))
if (kind !== undefined && markers.has(name)) { skippedByMarker++; continue }
namesToScan.push(name)                                  // repo.ts:1582-1589
...
// write-back, per scanned name:
if (kind === undefined) await this.clearReprojectionMarker(name)   // repo.ts:1668-1669  ← CLEARS markers
else                    await this.setReprojectionMarker(name)     // repo.ts:1671
```

**Hypothesis (strong):** when the deferred reprojection actually runs
(`scheduleReprojection` → `requestIdleCallback`/`setTimeout`, repo.ts:1698), the
ref-typed property **schemas aren't all registered as ref-typed yet**, so
`refCodecKind(propertySchemas.get(name))` returns `undefined` for ~80 of the 83
names. That path:
  1. does **not** skip (so it re-scans), **and**
  2. **clears the marker** (repo.ts:1669), **and**
  3. computes references **without** that field's projection → **strips** those
     refs (writes `[]` / a shorter list).

Next load the schema may be present → it re-adds the refs and re-sets the marker.
Net effect: a **flip-flop** that rewrites `references_json` on ~16k blocks every
load and clears the very markers meant to stop it. The unresolved `alias === id`
also means reprojection's output differs from the incremental references
processor's resolved-alias output, so the diff guard (repo.ts:1649) fires every
time even for names that *are* scanned.

`requestIdleCallback`/`setTimeout(0)` deferral (intended to move the ~1.4 s scan
off the cold-start path) is what lets the scan run *before* schemas finish
registering. The 2 s `requestIdleCallback` timeout (repo.ts:1709) can fire while
dynamic-extension property schemas are still loading.

### Continue here (Issue A)

1. **Confirm the schema-timing theory.** At reprojection time, log how many of
   `namesToScan` have `refCodecKind(...) === undefined`. If ~80, that's it.
   Live probe of which markers exist vs which names are currently ref-typed:
   ```
   # markers present:
   SELECT key FROM client_schema_state WHERE key LIKE 'reproject_ref:%' ORDER BY key;
   # then compare to the ref-typed names the runtime reports:
   yarn agent --profile ff-vlad-dev eval \
     "return [...repo.propertySchemas?.entries?.() ?? []].filter(([,s]) => /* ref-typed */ true).map(([n]) => n)"
   ```
   (Use `describe-runtime` / the real `refCodecKind` to classify — see
   `latestRefProjectionSchema` / `refCodecKind` imports in repo.ts.)
2. **Likely fixes (pick after confirming):**
   - Don't run reprojection until the property-schema set is fully resolved
     (gate `scheduleReprojection` on the *final* `setFacetRuntime`, or pass a
     "schemas complete" signal). The code deliberately doesn't bail on the
     double `setFacetRuntime` (repo.ts:1607-1617) — that reasoning breaks when a
     name is ref-typed in the *final* schema set but absent in the early one.
   - **Don't clear a marker just because a name looks non-ref-typed in a
     possibly-incomplete schema snapshot** (repo.ts:1668-1669). Only clear on a
     real ref→non-ref transition, established against the complete schema set.
   - Consider making the diff stable: reprojection writing `alias === id`
     (unresolved) guarantees a diff vs the processor's resolved alias. Either
     resolve aliases in the projection, or don't include `alias` in the stored
     `references_json` (treat it as render-time only).
3. **Was this made worse by the Layout B cutover (part of PR #105)?** Open
   question worth checking: did reprojection churn this badly *before* the
   cutover? The cutover changed how `blocks` is populated (observer materializes
   from `blocks_synced`), which could change schema-load ordering at cold start.
   The reprojection code itself predates e2ee (`afb45f0d Add ref-typed property
   backlinks`), but the *timing* it runs under may have shifted.
4. **Add a regression guard / metric alarm:** `repo.metrics().reprojection`
   already exists — a test (or a dev-console warning) that flags
   `blocksUpdated > 0` on a *second* cold start of the same DB would have caught
   this.

---

## Issue B — unsealed PATCH on an e2ee block rejected (the "1 sync issue")

### Evidence

Rejected row (`ps_crud_rejected`):

```
SELECT data, error_code, error_message FROM ps_crud_rejected;
```
```json
{"op":"PATCH","type":"blocks","id":"469ecc66-34de-5a0e-a85a-a69c69477fb2",
 "data":{"properties_json":"{\"activePanelId\":\"e18a1e8e-982f-426f-be7c-9219cfb5a4eb\"}",
         "updated_at":1780927417279}}
```
- `error_code` 23514, message: *"blocks in an e2ee workspace must carry a
  well-formed enc:v1: envelope in all content columns."*
- The PATCH carries **plaintext `properties_json`** (panel/layout UI-state:
  `activePanelId`) and **no `workspace_id`**.

This block is a **layout/UI-state block in the e2ee workspace** (`e2eet1`,
`2de56b00-…`). The 8 queued e2ee-workspace PATCHes alternate between
`references_json:"[]"` and non-references PATCHes — the rejected one is the
`properties_json` UI-state write.

### Why it went up unsealed (hypotheses)

Encrypt-on-upload (`encryptUploadColumns` in the connector, `src/services/powersync.ts`)
seals `content` / `properties_json` / `references_json` for e2ee workspaces by
looking up the workspace key via `workspace_id`. The rejected PATCH **has no
`workspace_id`**, so the hook can't resolve the workspace/mode → can't seal →
sends plaintext → trigger rejects.

But the upload triggers are supposed to emit `workspace_id` **unconditionally on
every PATCH** precisely so the encrypt hook always has it
(`blockUploadPatchJsonSql`, see [`src/data/internals/clientSchema.ts`](src/data/internals/clientSchema.ts)
~around the `CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL`). So either:
  - the rejected PATCH is a **stale queue entry** created *before* the
    unconditional-`workspace_id` change shipped (check `rejected_at` /
    whether the deployed trigger predates it), **or**
  - this UI-state block is written through a path that **bypasses** the
    `blocks_upload_update` trigger (so no `workspace_id` is added), **or**
  - `getWorkspaceMode(workspace_id)` resolved `none` for the e2ee workspace at
    upload time (pin/resolver race right after create) and the seal was skipped.

A second angle worth a hard look: **should panel/layout UI-state
(`activePanelId`) even live as a synced block inside an e2ee workspace?** If
layout-session/UI-state blocks are being created in the e2ee workspace, they'll
keep tripping the ciphertext trigger unless they're sealed like any other block.

### Continue here (Issue B)

1. **Identify the block + its write path:**
   ```
   yarn agent --profile ff-vlad-dev sql all \
     "SELECT id, workspace_id, substr(content,1,60) content, substr(properties_json,1,120) props FROM blocks WHERE id='469ecc66-34de-5a0e-a85a-a69c69477fb2'"
   ```
   Confirm it's the layout-session/panel-state block (`getLayoutSessionBlock` /
   `stateBlocks.ts`) and how it's created in the e2ee workspace.
2. **Check whether the queued PATCH actually has `workspace_id`** for a *fresh*
   e2ee edit (write a block in `e2eet1`, then look at its new `ps_crud` row): if
   a fresh PATCH includes `workspace_id`, the rejected one is stale; if not, the
   trigger/`workspace_id` emission has a gap for this path.
3. **Check the connector seal path** in `src/services/powersync.ts`
   (`encryptUploadColumns` / `getWorkspaceMode` / `getCek`): what happens when
   `workspace_id` is absent from a PATCH, and when `getMode` returns `none`/the
   key is missing for an e2ee workspace. It must **not** send plaintext for an
   e2ee workspace — better to stop the tx (fail-closed) than emit plaintext that
   the server rejects.
4. **Decide on UI-state blocks in e2ee workspaces** — seal them like content, or
   keep layout/session state out of synced blocks.

---

## Ruled out / reassurances

- **The Layout B observer is NOT echoing downloads → uploads.** Materialization
  writes with `tx_context.source = NULL` ([`src/sync/observer/materialize.ts`](src/sync/observer/materialize.ts):335),
  and the upload triggers fire only on `source IS NOT NULL`
  ([`src/data/internals/clientSchema.ts`](src/data/internals/clientSchema.ts):528/545).
  The observer's only post-materialize side effects are cache invalidation +
  cycle scan ([`src/sync/observer/observer.ts`](src/sync/observer/observer.ts):164-167) — **no `repo.tx` write-back**. So the
  flood is not a sync echo loop.
- **Content/properties are intact.** The flood is `references_json` (derived
  backlinks) — recomputable from content+properties, so the churn is recoverable
  and not data loss. Only ~8 full PUTs + a few genuine edits touch other columns.
- **No plaintext leaked to the server for the e2ee workspace** — the ciphertext
  trigger rejected the one unsealed PATCH (fail-closed working as designed).

## Suggested order of attack

1. **Issue A first** — it's the queue flood and the "not draining." Fix the
   marker gate / schema-timing so reprojection runs once and stops. That alone
   stops ~16k PATCHes/load.
2. **Issue B** — fix the unsealed-PATCH path (workspace_id emission and/or the
   connector's fail-closed behavior for e2ee), then dismiss/retry the rejected
   change.

## Quick command appendix

```
yarn agent --profile ff-vlad-dev eval "return repo.metrics().reprojection"
yarn agent --profile ff-vlad-dev sql all "SELECT COUNT(*) rows, COUNT(DISTINCT json_extract(data,'\$.id')) blocks FROM ps_crud"
yarn agent --profile ff-vlad-dev sql all "SELECT je.key col, COUNT(*) n FROM ps_crud, json_each(json_extract(ps_crud.data,'\$.data')) je GROUP BY je.key ORDER BY n DESC"
yarn agent --profile ff-vlad-dev sql all "SELECT data, error_code FROM ps_crud_rejected"
yarn agent --profile ff-vlad-dev sql all "SELECT COUNT(*) FROM client_schema_state WHERE key LIKE 'reproject_ref:%'"
# session-2 additions:
yarn agent --profile ff-vlad-dev eval "const s=(repo.db||db).currentStatus; return {uploading:s.dataFlowStatus.uploading, uploadError:String(s.dataFlowStatus.uploadError?.message), downloadError:String(s.dataFlowStatus.downloadError?.message)}"
yarn agent --profile ff-vlad-dev sql all "SELECT MIN(id) lo, MAX(id) hi, COUNT(*) n FROM ps_crud"   # lo pinned at oldest ⇒ not draining
```

---

## Update (session 2, 2026-06-08): verified root cause + the drain stall

Re-ran the live probes (numbers identical to the original: `reprojection =
{calls:2, schemasReprojected:83, blocksUpdated:16264, skippedByMarker:3}`,
markers `= 86`, `ps_crud = 34,232` rows / 16,273 blocks) and traced the code.
**Three findings, two corrections.**

### Finding 1 — the marker gate is defeated by *transient schema absence*, and the trigger is the Layout B cutover (so the user is right: it started with the merge)

Decisive live evidence: **86 reprojection markers exist, yet only 3 of 83 names
are skipped.** Markers persist in `client_schema_state` across reloads, so a
*marked* name can only fail the skip gate
([repo.ts:1582-1589](src/data/repo.ts:1582)) when
`refCodecKind(propertySchemas.get(name)) === undefined` — i.e. the schema
snapshot handed to reprojection **does not see that name as ref-typed**. That can
only happen when `changedRefSchemaNames`
([repo.ts:217](src/data/repo.ts:217)) flagged the name as a **ref→non-ref
transition** because it was *absent from the snapshot*, not because the user
made it non-ref.

Why does it go absent? The 83 names are user-data ref-typed schemas (live:
**87 ref-typed total = 78 `roam:*` + 9 `readwise:*`/`groupWith`/`location`/…**;
the marker names are exactly these). They're loaded by `UserSchemasService`
([userSchemasService.ts:133](src/data/userSchemasService.ts:133)), which
**subscribes to `property-schema` blocks in the `blocks` table** and republishes
the whole bucket on every delivery (`rebuildFromBlocks` does
`this.contributions = next`, a full replace). The **Layout B cutover**
(`0ca207ed`, bundled into the PR #105 merge) made `blocks` a *locally
materialized* table that the observer fills **gradually** from `blocks_synced`
(PowerSync now writes only `blocks_synced`). So at cold start the subscription
delivers an empty/partial schema-block set first, and a workspace-restart
(`userSchemas.start()` is keyed on `workspaceId`) or a REPLACE re-materialization
(`943b4d8f`) can momentarily **shrink** it → the bucket drops these schemas → a
rebuild publishes a snapshot where they're absent → `changedRefSchemaNames` reads
"ref→non-ref" → `scheduleReprojection` runs against that snapshot →
the gate can't skip them (`kind === undefined`), it **strips their refs to `[]`
and clears their markers** ([repo.ts:1638-1673](src/data/repo.ts:1638)). The next
rebuild re-adds them → another reprojection re-adds refs + re-sets markers.
**Flip-flop → ~16k `references_json` PATCHes every reload.**

This matches the queued payloads: **6,988 PATCHes set `references_json` to `[]`
(the strip) + 27,226 set it non-empty (the re-add)**.

→ Correction to the original "Issue A (pre-existing, NOT e2ee-specific)": the
reprojection *code* predates e2ee, but it was **latent**. The Layout B
cutover changed cold-start `blocks`-population timing, which is what makes the
flip-flop fire every reload. Practically, **it did start with the merge.**

### Finding 2 — the "`alias === id` guarantees a diff" theory is WRONG

Both projections write `alias === id` for property refs:
`projectPropertyReferences` (the incremental processor,
[referenceProjection.ts:20](src/plugins/references/referenceProjection.ts:20))
and `projectedRefsForField` (reprojection,
[repo.ts:238](src/data/repo.ts:238)) are identical. So the alias is **not** the
diff driver. The diff that fires on each scanned block is the genuine
strip/re-add of property refs (and possibly ordering of `[...retainedRefs,
...addedRefs]` vs stored order). Don't spend time "resolving aliases in the
projection" — it won't help.

### Finding 3 (NEW, operationally primary) — the queue never drains because the oversized PATCH RPC hits a Postgres statement timeout

Why "not draining": live status shows `uploading: true`, **`uploadError =
"canceling statement due to statement timeout"`** (Postgres SQLSTATE `57014`),
and `ps_crud` ids are contiguous from the *oldest* (`MIN(id)` pinned) — PowerSync
is retrying the same batch forever.

Mechanism: `applyBlockPatchesRpc`
([powersync.ts:291](src/services/powersync.ts:291)) ships **every PATCH in the
whole compacted batch as one `apply_block_patches` RPC** — **no size cap**
(contrast CREATEs, which chunk at `MAX_BLOCKS_PER_SUPABASE_UPSERT = 500`,
[powersync.ts:329](src/services/powersync.ts:329)). With ~16k blocks queued, that
single server statement runs ~16k UPDATEs, each firing the per-write server
triggers (`blocks_history`, etc.) → exceeds `statement_timeout` → `57014`.
`classifyUploadError` ([uploadErrorClassifier.ts:46](src/services/uploadErrorClassifier.ts:46))
has no rule for `57` and **defaults to `transient`** (correct policy: never drop
writes) → the batch is re-thrown and **retried forever**.

So Issue A (flood) and Finding 3 (stall) are causally linked: the flood inflates
the batch past the timeout. But the **uncapped PATCH RPC is an independent
scalability bug** — any large legitimate batch (a big import/paste) would wedge
the queue the same way.

There's also a `downloadError` ("Failed to create websocket connection to
…powersync…/sync/stream"). May be transient/aggravating; lower priority — recheck
after the upload path is healthy.

### Fix plan (revised priority)

1. ✅ **DONE** (`9fc1b872`) — **Cap the PATCH RPC batch** (Finding 3). Chunk
   `applyBlockPatchesRpc` at `MAX_PATCHES_PER_SUPABASE_RPC = 500` (mirrors the
   CREATE upsert cap), reusing `chunked(...)`. Patches are column-narrow and
   idempotent, so splitting across separate RPC transactions is safe. Unwedges
   the current 34k-row queue and hardens against any large legitimate batch.
2. ✅ **DONE** (`0ddad24a`) — **Stop the flood at the source** (Finding 1). The
   reprojection gate now treats a name *absent* from its schema snapshot as
   "not loaded yet" (skip — leave refs and marker untouched), and only a
   *present non-ref* schema as a real ref→non-ref transition that strips refs +
   clears the marker. `latestRefProjectionSchema` keeps the scheduled schema
   when the live registry no longer knows the name (so a parked ref-typed scan
   can't strip a still-ref-typed field that transiently vanished). Added a
   `reprojection.skippedAbsent` metric (the flood signal) and a regression
   guard: zero `blocksUpdated` across a disappear/reappear cycle. **Accepted
   tradeoff:** genuinely deleting a ref-typed property schema no longer eagerly
   sweeps its derived backlinks — the references processor strips them on the
   next write to each affected block. A deliberate "schemas settled" sweep
   could reclaim that later if it ever matters.
3. **TODO — Issue B** — the `activePanelId` UI-state block in the e2ee workspace
   goes up unsealed (no `workspace_id`, plaintext `properties_json`). Root:
   `2acf5183` ("UI-state writes upload uniformly", also bundled in the merge)
   removed the local-ephemeral sink that previously kept UI-state out of the
   queue. Decide: seal it (ensure the upload trigger emits `workspace_id` for
   this write path so the connector can seal) **or** keep layout/session
   UI-state out of synced blocks in e2ee workspaces. Then dismiss/retry the 1
   quarantined row.
4. **TODO — Recheck** `downloadError` once Issue B lands.

### Live recovery (after the fixed build ships)

The two fixes are client-side; `ff-vlad-dev` is still running the old build.
On the next load of the fixed build, recovery is automatic and needs no manual
`ps_crud` surgery:

- **Queue drains:** the existing 34k PATCHes upload in 500-row RPC chunks
  instead of one 16k-row statement that times out.
- **No new flood:** the 86 markers are already present, so the fixed gate skips
  them on cold start (and transient absence no longer clears them).
- Watch `repo.metrics().reprojection` — `blocksUpdated` should be ~0 and
  `skippedAbsent` may be non-zero (proof the guard fired) — and confirm
  `ps_crud` `MIN(id)` starts advancing.

The 1 quarantined `ps_crud_rejected` row (Issue B) is separate — dismiss/retry
it after Issue B is fixed.

Verification gate per [AGENTS.md](AGENTS.md): `yarn run check`.
