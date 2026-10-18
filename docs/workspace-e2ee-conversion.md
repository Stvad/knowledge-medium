# In-place plaintext → E2EE workspace conversion

> **Status:** proposal — nothing here is built. Last verified against code: 2026-10-18 (master `13d3f0dc72`).
> Tracking: epic #1295. Child pieces are listed in [§12](#12-tracking).

## 1. Goal

Make an existing plaintext workspace end-to-end encrypted. Keep everything the user has built:

- block ids, and so every `((id))`, ref property, backlink and URL;
- timestamps and authorship;
- extension approvals;
- the device-local change history.

When it finishes, nothing on the backend holds the workspace's content in plaintext. A breach of the database, Storage or sync service then yields only what the e2ee design already accepts as metadata (`docs/e2ee-design.html` §15).

Non-goals:

- **e2ee → plaintext.** It stays impossible.
- **Workspace-key rotation.** It is the same machinery (see [§10](#10-relation-to-workspace-key-rotation)), but it is not built here.
- **Hiding metadata** the e2ee design already leaves visible.

## 2. Decision: convert in place, not by copy

`docs/e2ee-design.html` §10 says crossing modes means *export + create a new workspace + import*. For a workspace with years of history, that path loses most of what makes it worth keeping.

**Block ids cannot survive a copy.**
- `blocks.id` is the primary key on its own, both on the server (`supabase/migrations/20260510222352_consolidated_initial.sql`, `blocks_pkey`) and locally (`src/data/blockSchema.ts`).
- So an id can exist in only one workspace, random v4 ids included.
- A copy would re-id every block, then rewrite every `((id))` / `!((id))` / `[label](((id)))`, every ref and refList value, every `references_json` entry and every `parent_id`.
- No code does that today.
- The only existing export/import already drops properties and timestamps (#401).

**History cannot follow a copy.**
- Clients cannot insert into `blocks_history`; only its trigger writes it.
- Local `row_events` is keyed by block id, and its snapshots embed the old ids.

**Everything keyed by workspace id or block id breaks:** URLs (`#<ws>/<block>`), extension approvals (keyed by extension block id, per device), membership.

In place, all of that is kept. Ids stay the same, so the AAD that binds each sealed column to (block id, workspace id, column) (`src/sync/transform.ts`) needs no rebinding. The cost is that the "mode is immutable" invariant gets a single, one-directional exception ([§4](#4-the-invariant-we-relax)).

## 3. What the backend holds for a plaintext workspace today

This inventory is the purge checklist. Everything here was verified in the repo except the platform rows, which are [§8](#8-platform-residue-and-when-it-is-safe-if-breached).

| Surface | What it holds | Source |
|---|---|---|
| `blocks` | `content`, `properties_json`, `references_json` in plaintext. Soft-deleted rows keep their content forever. | consolidated initial migration |
| `blocks_history` | INSERT rows: the full row (`to_jsonb(NEW)`). UPDATE rows: old and new values of every changed column. DELETE rows: the full old row. Never pruned. No foreign key to `workspaces`, so `delete_workspace` leaves it in place. By standard cascade semantics (not covered by a repo test), the delete also adds a full-row DELETE entry per cascaded block. Only the trigger writes it. | `20260522062437_add_blocks_history.sql` |
| Storage `attachments` | Unencrypted bytes at `<ws>/<hex(sha256(plaintext))>`. The path itself confirms content to anyone who can guess the file. Nothing deletes objects: there is no GC, and workspace delete doesn't touch Storage. | `20260625000000_add_attachments_storage.sql`, `src/sync/crypto/contentKey.ts`, `src/sync/byteTransform.ts` |
| Derived block ids | Ids hashed from user text under a namespace that is public in this repo. **Alias seats**: page name → id, `src/data/targets.ts`, open for e2ee workspaces too (#719). **Media blocks**: file sha256 → id, `src/plugins/attachments/mediaCapture.ts`. Ids are plaintext in both modes, so these stay a guess oracle after encryption. | as cited |
| `workspaces.name` | Plain text in both modes. Synced and shown in invitations. | `src/data/workspaceSchema.ts` |

No other server table holds content. The `public` schema has `workspaces`, `workspace_members`, `workspace_invitations`, `blocks` and `blocks_history`. There are no edge functions, no pg_cron jobs and no content-copying workflows.

## 4. The invariant we relax

`workspaces_prevent_e2ee_field_change` (`20260529120000_add_e2ee_workspace_columns.sql`) refuses every change to `encryption_mode` and `wk_canary`, with no role exception. The local mode pin (`src/sync/keys/modePin.ts`) is set-once and throws on any change.

The conversion admits **exactly one transition**, `none → e2ee` with a well-formed canary, and only in two places:

- **Server.** Only the conversion's SECURITY DEFINER apply function may make it. The trigger admits it with the same `current_user in ('postgres', 'service_role')` check the owner and `properties_migration` triggers already use (`20260820115000_workspaces_owner_is_not_client_writable.sql`). e2ee → none and any canary change on an e2ee row stay refused, so rotation remains future work.
- **Client.** `setModePin` stays set-once. A separate, narrowly named `upgradeModePinToE2ee` permits `plaintext → e2ee` only after a workspace key has opened the server's canary.

**Why this doesn't weaken the pin.** The pin exists to stop a server from *downgrading* a workspace (claiming e2ee → plaintext) so that a client starts uploading plaintext.

- A server that falsely claims plaintext → e2ee can only stall that device ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)). That is the DoS the e2ee design already accepts.
- The canary seals the workspace id under AAD that names the workspace. So a canary copied from another e2ee workspace does not open, and the server cannot trick a user into "unlocking" one workspace with another's key.

## 5. Design

### 5.1 Server: freeze, stage, apply, abort

Owner-only SECURITY DEFINER RPCs over a staging area in the `private` schema, which PostgREST doesn't expose (#1294):

- `private.workspace_conversions(workspace_id pk, state, started_by, started_at)`
- `private.workspace_conversion_rows`: the staged target image, one row per affected block id. Each row holds `op` (update | insert | delete), the sealed columns, any rewritten non-sealed columns (`parent_id` for children of a re-id'd block), and the **base** the client read: `sha256` of each sealed column's plaintext and the prior value of each non-sealed column it rewrites.

The four RPCs:

1. **`begin_workspace_conversion(ws)`** freezes the workspace.
   - A BEFORE trigger on `blocks` refuses every write to a frozen workspace unless it comes from the definer.
   - It raises **`PT429`**. PostgREST turns that into HTTP 429, which `classifyUploadError` retries forever (`src/services/uploadErrorClassifier.ts`).
   - So another device's queued edits stall rather than being quarantined. This is the same trick `blocks_refuse_anon` plays with `PT401` (`20261013120000_refuse_anon_writes_to_blocks.sql`).
   - A 22/23/42/P0002 code would quarantine those edits, which would lose them.
2. **`stage_workspace_conversion(ws, rows)`**, chunked.
   - It checks each row's base against the current server row: `sha256(convert_to(col, 'UTF8'))` per sealed column, plus equality for the rewritten non-sealed columns.
   - It refuses the chunk on any mismatch.
3. **`apply_workspace_conversion(ws, canary)`**, ONE transaction, with a raised `statement_timeout` (as `delete_workspace` has, `20260513205724_extend_delete_workspace_timeout.sql`). Its steps:
   1. Re-check completeness: every block of the workspace, **soft-deleted ones included**, has a staged row, and every staged id exists or is an insert.
   2. Re-check every base.
   3. Set `encryption_mode = 'e2ee'` and `wk_canary` **first**, so `blocks_require_ciphertext_for_e2ee` validates every row the next step writes.
   4. Apply the updates, inserts and deletes.
   5. `DELETE FROM blocks_history WHERE workspace_id = ws`. That includes the rows step 4 just wrote: their `before_diff` holds the old plaintext.
   6. Clear the staging rows and the freeze.
4. **`abort_workspace_conversion(ws)`** clears the freeze and discards the staging rows. Nothing else changed.

Why the freeze and the base checks are both needed:

- The freeze guarantees that nothing writes the workspace between the client's read and the apply.
- The base checks prove that the client read the frozen state and not an older one.
- `updated_at` alone can't serve as the version. The clamp floors it at `OLD.updated_at` and only guarantees a bump when content changes (`20260803000000_add_patch_base_version_drift_bump.sql`), so a `parent_id`-only write can leave it unchanged.

Why history is deleted inside the transaction instead of suppressing the history trigger:

- The history trigger is a SECURITY DEFINER function, so `current_user` inside it cannot tell the conversion apart from any other write.
- Adding a bypass to a trigger that sits on every write fleet-wide is a larger permanent risk than one extra delete in a function that runs once per workspace.
- The cost is transient: the apply writes history rows and then deletes them, which leaves dead tuples ([§7](#7-runbook) step 8 vacuums them).

### 5.2 Client: a plaintext-pinned device that sees e2ee

Today `getMaterializability` returns `copy` for any workspace pinned plaintext, whatever the server says (`src/sync/keys/resolver.ts`). After a conversion, such a device would:

- write `enc:v1:` strings into `blocks` and its FTS and alias indexes;
- upload plaintext edits, which the ciphertext trigger rejects permanently.

That is no leak, since the server refuses them, but the device is broken and those edits are lost to quarantine.

Change (#1293). When the synced `workspaces` row says `e2ee` and the pin says `plaintext`:

| | Today | After |
|---|---|---|
| Materialize | `copy` | `defer`: rows stay staged in `blocks_synced` |
| Upload | unsealed | **held** for that workspace; nothing is sent |
| UI | — | unlock prompt (paste the workspace key) |

**Upgrade.** Once a key opens the server canary, the existing `unlockWorkspaceWithKey` checks run and then `upgradeModePinToE2ee`.

- A device whose key store already holds a key that opens the canary upgrades without asking. That is the converting device, or one that crashed after the apply.
- On upgrade, every staged `blocks_synced` row of the workspace is marked for re-apply. That repairs a device that ran an older build across the conversion and had already copied ciphertext into `blocks`.
- The held uploads then drain, sealed. `encryptUploadColumns` resolves the mode per op at upload time.
- A content-only patch is accepted at that point, because every server row already has all three columns sealed.

This must be deployed to every device **before** any conversion runs.

**The upload queue is FIFO.** PowerSync uploads a device's transactions in order, so holding one op stalls everything queued behind it on that device. The unlock prompt is what clears it.

**Known gap: an edit made during the window.**
- During the freeze, another device's plaintext edit gets `PT429` and retries.
- The workspace row's mode change arrives in the same large checkpoint as every resealed block. So that device's next retry can land before it learns the workspace is e2ee.
- If it does, the ciphertext trigger refuses the edit with a permanent code and quarantines it (`ps_crud_rejected`, still on that device).
- **Recovery:** after that device upgrades, the System Status rejection dialog's **Retry** re-queues the edit, and the upload path seals it under the now-e2ee mode.
- An edit like that can also carry pointers to blocks the conversion re-id'd ([§5.3](#53-the-target-image-pure)), so they would dangle.
- The runbook's "drain every queue, pause editing elsewhere" ([§7](#7-runbook)) keeps this off the normal path. Making the ciphertext trigger's refusal transient instead would close the gap, but it would also make a genuinely buggy client jam its whole queue forever. So that trade is declined.

### 5.3 The target image (pure)

`buildConversionImage(serverRows, keyMaterial) → {stagedRows, idMap, residue}` (#1292).

Its input is the workspace as this device's `blocks_synced` holds it: the server image, every row, soft-deleted included.

1. **Classify** derived ids whose key is user text:
   - **Alias seats.** A block is a seat if its id equals `computeAliasSeatId(alias, ws, i)` for one of its current aliases. Historical aliases also count: local `row_events` snapshots and server `blocks_history` content (read before the purge), for `i` up to `ALIAS_SEAT_PROBE_SLOTS`. A seat renamed before any history covers it can't be recognised. That residue is **counted and reported**, never silently dropped, and accepted (see [§6](#6-what-stays-visible-afterwards)).
   - **Media blocks.** `mediaBlockId(ws, sha256hex)` for each media block's `media:hash`.
   - **Left alone, on purpose:**
     - Code-owned keys: kernel pages, definition seeds, plugin ids, the user page, state children.
     - Enumerable or foreign keys: daily-note ISO dates, Roam uids.

     The app re-derives these ids to find the blocks, so changing them would mint duplicates.
2. **Re-id.**
   - Alias seats go to the K_id-derived alias namespace. That namespace is #719's fix, so #719 must land first, or new seats would keep minting public ids.
   - Media blocks go to `mediaBlockId(ws, HMAC(K_id, sha256))`, the id an e2ee capture of the same file would mint. Without this, deduplication would mint a second block for the same file.
3. **Rewrite every pointer** to a re-id'd block:
   - `((id))`, `!((id))` and `[label](((id)))` in content;
   - ref and refList values;
   - `references_json` entries;
   - `parent_id`;
   - transitively, any derived id whose key embeds a re-id'd parent.

   The existing in-workspace helpers are the starting point (`rewriteBlockRefs` in `src/plugins/references/referenceParser.ts`, `retargetReferences` in `src/plugins/references/mergeRetargetProcessor.ts`). Here they run over plaintext rows before sealing, not inside a tx.
4. **Seal** each row's three content columns with the existing envelope and AAD (`encodeForWire`).
5. **Emit** the base fingerprints of [§5.1](#51-server-freeze-stage-apply-abort).

Correctness oracle (property/fuzz test): open every staged row, invert `idMap`, and the result equals the input exactly, with every pointer resolving.

Sizing:
- base64url adds a third;
- each sealed column adds a 12-byte nonce, a 16-byte tag and the `enc:v1:` prefix;
- so the staged image is about 1.33× the plaintext plus roughly 135 bytes per row.

That is an estimate, not a measurement. Every row changes, so every device re-downloads the whole workspace afterwards.

### 5.4 Attachments

For every media block, soft-deleted included (#1291):

1. Get the plaintext bytes: the local byte store, else a download.
2. Seal them under the workspace key.
3. Upload to `<ws>/<HMAC(K_id, sha256)>`.

The keyed-path and sealing logic already exists:
- `captureMedia` (`src/plugins/attachments/mediaCapture.ts`) derives the key and the media id;
- the upload drain (`src/plugins/attachments/uploadDrain.ts`, `src/sync/byteTransform.ts`) seals and uploads.

The conversion reuses them but not `captureMedia` itself, which writes its own block, whereas here the block comes from the image. Paths are write-once, so a retry treats an existing object whose head is `encb:v1:` as done.

This all happens **before** the apply, so no media block ever points at missing bytes. The old plaintext objects are deleted only **after** the apply commits and the existing ciphertext audit (`src/plugins/attachments/audit/`) passes for the workspace. Missing source bytes are reported per block.

### 5.5 History: archive, then purge

The server's `blocks_history` for the workspace is plaintext and must go. Nothing in the app reads it: the `block_history` tool reads local `row_events` (`src/plugins/agent-runtime/changeHistory.ts`), and only `scripts/supabase-health.mjs` reads the server table. So:

- **Archive.** Before the freeze, the converting client exports the workspace's `blocks_history` (members can SELECT it under RLS) as chunks sealed under the workspace key, and the user keeps the file offline. No plaintext copy is ever written to disk, and the archive is useless without the key.
- **Purge** inside the apply ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Later, if wanted.** Block ids don't change, so a future importer can re-seal archived values under the same per-(block, workspace, column) AAD and insert them through an owner-only RPC. That turns the archive back into encrypted server history. Re-sealing history in place now would build that importer before anything reads the result, so it is deliberately left for later.

Local `row_events` is device-local and never synced, so it is untouched and stays intact for every block that keeps its id. On the converting device, the rows of re-id'd blocks (seats and media) can be remapped from `idMap` (an optional step in #1290). Other devices keep that history under the old ids.

### 5.6 Flow and failure paths

The orchestrator (#1290) refuses to start unless all of these hold:

- the user owns the workspace;
- the local upload queue is drained;
- no rejected rows are pending for the workspace.

| Step | If it fails | State left behind | Recovery |
|---|---|---|---|
| 1. Generate the workspace key, reveal it once, require a retype, store it in the key store **before** any server change | before anything else | nothing changed | retry |
| 2. Export the sealed history archive | download error | nothing changed | retry |
| 3. Freeze | RPC error | not frozen | retry |
| 4. Wait for `blocks_synced` to reach a checkpoint taken after the freeze, then build the image | crash | frozen; other devices' edits are held | resume, or abort |
| 5. Re-upload attachments | partial | extra ciphertext objects; harmless | resume (write-once paths are idempotent) |
| 6. Stage chunks | base mismatch | frozen, partly staged | rebuild those rows and re-stage, or abort |
| 7. Apply | refusal or timeout | the transaction rolls back; frozen | fix the cause and re-apply, or abort |
| 8. Upgrade the local pin | crash after the apply | server is e2ee, pin is plaintext | automatic on restart: the stored key opens the canary ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)) |
| 9. Verify: every row opens, the attachment audit passes, zero history rows remain | a check fails | converted | investigate; nothing is lost while the key is held |
| 10. Delete the old plaintext objects | partial | plaintext objects remain | resume; report |

**Losing the key after the apply** makes the server copy unrecoverable. Devices that still hold plaintext `blocks` defer instead of copying ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)), so their local plaintext survives and can be exported. That is the last line of defence, not a plan. Store the key in two independent places before step 3.

## 6. What stays visible afterwards

These are accepted by the e2ee design (§15) and unchanged here:

- tree shape and ordering;
- `created_at` / `updated_at` / `user_updated_at`, including the original creation dates the conversion deliberately keeps;
- edit timing, authorship and `deleted` flags;
- ciphertext lengths;
- `workspaces.name`, which should be renamed during the runbook if it is sensitive.

Derived ids that keep their public-namespace hash:

- **Daily notes.** They reveal which dates have a note. The dates are enumerable, and the design already accepts edit-timing metadata.
- **Roam-import ids.** Only testable by someone who already holds the source graph.
- **Code-owned ids.** They reveal which plugins and features a workspace uses, not what the user wrote.
- **Unrecognised alias seats** ([§5.3](#53-the-target-image-pure) step 1). They stay page-name oracles. The conversion reports their count, and that count is the honest size of this residue.

## 7. Runbook

The first production run is #1288. Before:

1. **Key custody.** Store the workspace key in two independent places, such as a password manager and paper.
2. **Backup.** Take a full local SQLite export (the raw-SQLite export action, `src/utils/exportSqliteDb.ts`). It is plaintext, so keep it encrypted offline. This is the rollback.
3. **Fleet.**
   - Every device runs a build with #1293, or is wiped (the browser's "clear site data").
   - Every device's upload queue is drained.
   - Editing on other devices pauses for the duration.
4. **Ordering.** Leave the workspace on the `cell` properties model until afterwards. Property-definition synthesis runs only during the properties-as-blocks switch (`src/plugins/properties-migration/action.ts`), and on an e2ee workspace it mints K_id-keyed ids (`resolveSynthesisNamespace` in `src/data/internals/propertyDefinitionSynthesis.ts`). Switching first would mint public, name-derived definition ids that this conversion doesn't re-id.
5. Run the flow from a desktop, the device with the most attachment bytes stored locally.

After:

6. Verification passes ([§5.6](#56-flow-and-failure-paths) step 9).
7. Other devices paste the key and upgrade.
8. Operator: `VACUUM FULL` on `blocks`, `blocks_history` and `storage.objects`. The apply and the purge leave plaintext in dead tuples, and Storage metadata rows hold the old sha256 paths. `VACUUM FULL` takes an exclusive lock, so expect a short write stall fleet-wide.
9. Operator: drop leftover ad-hoc tables from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`) if they still exist. They hold ids and timestamps, not content.
10. Act on #1289's findings and record the workspace's "safe from" date ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).

## 8. Platform residue, and when it is "safe if breached"

These copies live outside the repo's reach, so none of them is verified here; #1289 confirms each with its source:

- **Supabase daily backups / PITR and WAL archives.** They hold plaintext until they age out. Early deletion is probably not possible.
- **Postgres error logs.** Constraint failures can print "Failing row contains (…)".
- **Storage-layer versioning or soft delete** of deleted objects.
- **PowerSync Cloud bucket storage.** It likely keeps superseded operations with full row data until compaction. Two open questions: whether compaction can be forced, and whether deploying changed sync rules reprocesses from scratch.

So the honest claim is: once the conversion commits, a breach of the **live** database, Storage or sync service exposes only ciphertext and the metadata in [§6](#6-what-stays-visible-afterwards). A breach of a **backup** is safe only after the longest retention window above has passed since the conversion (and the vacuum). The runbook records that date.

## 9. What the workspace gives up

- **Server-side anomaly detection.** The L5 detectors in `scripts/supabase-health.mjs` are documented as plaintext-only, so they go blind for the workspace.
- **The consistency check**, until it is fixed (#233).
- **Any future server-side feature**, such as search, AI or server-rendered or anonymous share links (`docs/e2ee-design.html` §10/§15).
- **Recovery.** A lost key means the server copy is lost.
- **A one-time full re-download** on every device.

## 10. Relation to workspace-key rotation

Rotation (`docs/e2ee-design.html` §14, unbuilt) needs the same steps:

- re-seal every row;
- set a new canary through a privileged path;
- remove or re-seal the history sealed under the old key;
- re-upload attachments under the new K_id's paths;
- re-id K_id-derived blocks: media ids, synthesized definitions, and alias seats once #719 lands.

Plaintext → e2ee is that operation starting from "no key". The freeze / stage / apply RPCs, the image builder and the attachment pass should therefore be written over a *source* key that may be absent, not with "plaintext" hard-coded. That way rotation later adds one admitted transition (`e2ee → e2ee` with a new canary) and a decrypt step, not a second machine. Rotation itself is deliberately not built here.

## 11. Alternatives considered

- **Export → new e2ee workspace → import.** Rejected, see [§2](#2-decision-convert-in-place-not-by-copy). It keeps an untouched fallback workspace, but the full local export in the runbook gives the same rollback.
- **Gradual re-upload through the normal patch path, no freeze.** Rejected. The ciphertext trigger checks the whole new row, so once the mode flips, an ordinary content-only edit to a row that hasn't been resealed yet is rejected. Without the flip, plaintext-pinned peers keep uploading plaintext. Mixed states are visible to every device.
- **Suppressing the history trigger during the apply.** Rejected in favour of deleting inside the transaction, see [§5.1](#51-server-freeze-stage-apply-abort).
- **Wiping every other device instead of the pin upgrade.** Still available per device in the runbook. It doesn't replace #1293, because an old or offline device must never treat ciphertext as content.
- **Re-sealing server history in place now.** Deferred, see [§5.5](#55-history-archive-then-purge).
- **Re-iding every derived id.** Rejected. The app finds daily notes, kernel pages, seeds and plugin records by re-deriving their ids, so moving them mints duplicates. Their keys aren't user text anyway ([§6](#6-what-stays-visible-afterwards)).

## 12. Tracking

| Piece | Issue | Waits on |
|---|---|---|
| Epic | #1295 | — |
| Server freeze/stage/apply RPCs and the one-way mode admit | #1294 | — |
| Plaintext-pinned device sees e2ee: defer, hold, one-way pin upgrade | #1293 | — |
| Target-image builder | #1292 | #719 |
| Attachment re-seal | #1291 | — |
| Orchestrating flow | #1290 | #1291, #1292, #1293, #1294 |
| Platform retention spike | #1289 | — |
| First production run (runbook) | #1288 | #1289, #1290, #1293 |
