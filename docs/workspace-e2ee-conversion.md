# In-place plaintext → E2EE workspace conversion

> **Status:** proposal — nothing here is built. Last verified against code: 2026-10-18 (master `13d3f0dc72`).
> Tracking: epic #1295. Child pieces are listed in [§12](#12-tracking).

## 1. Goal

Make an existing plaintext workspace end-to-end encrypted while keeping everything the user has built:

- **Every block id**, so every `((id))`, ref property, backlink and URL keeps working.
- **The user-visible timestamps** (`created_at`, `user_updated_at`) and authorship.
- **Extension approvals.**
- **The device-local change history.**

When it finishes, nothing on the backend holds the workspace's *content* in plaintext. A breach of the database, Storage or the sync service then yields only ciphertext plus the metadata listed in [§6](#6-what-stays-visible-afterwards). Most of that metadata the e2ee design already accepts (`docs/e2ee-design.html` §15).

The conversion only re-seals. It changes no block id: not even the derived ids that hash user text, which [§6](#6-what-stays-visible-afterwards) leaves to a separate migration.

Non-goals:

- **e2ee → plaintext** stays impossible.
- **Workspace-key rotation** (see [§10](#10-relation-to-workspace-key-rotation)) is not built here.
- **Re-iding derived blocks** belongs to that separate migration ([§6](#6-what-stays-visible-afterwards), #1297).

## 2. Decision: convert in place, not by copy

`docs/e2ee-design.html` §10 says crossing modes means *export + create a new workspace + import*. For a workspace with years of history, that path loses most of what makes it worth keeping:

- **Block ids cannot survive a copy.**
  - `blocks.id` is the primary key on its own, both on the server (`supabase/migrations/20260510222352_consolidated_initial.sql`, `blocks_pkey`) and locally (`src/data/blockSchema.ts`). So an id can exist in only one workspace, random v4 ids included.
  - A copy would re-id every block and rewrite every `((id))` / `!((id))` / `[label](((id)))`, ref and refList value, `references_json` entry and `parent_id`.
  - No code does that today, and the only existing export/import already drops properties and timestamps (#401).
- **History cannot follow a copy.**
  - Clients cannot insert into `blocks_history`; only its trigger writes it.
  - Local `row_events` is keyed by block id, and its snapshots embed the old ids.
- **Everything keyed by workspace id or block id breaks:** URLs (`#<ws>/<block>`), extension approvals (keyed by extension block id, per device), and membership.

In place, all of that is kept. Ids don't change, so the AAD that binds each sealed column to (block id, workspace id, column) (`src/sync/transform.ts`) needs no rebinding. The cost is one exception to the "mode is immutable" invariant, in one direction only ([§4](#4-the-invariant-we-relax)).

## 3. What the backend holds for a plaintext workspace today

This is the purge checklist. Everything here was verified in the repo, except the platform-level copies, which are in [§8](#8-platform-residue-and-when-it-is-safe-if-breached).

| Surface | What it holds | Source |
|---|---|---|
| `blocks` | `content`, `properties_json`, `references_json` in plaintext. Soft-deleted rows keep their content forever. | consolidated initial migration |
| `blocks_history` | INSERT rows hold the full row (`to_jsonb(NEW)`). UPDATE rows hold the old and new values of every changed column. DELETE rows hold the full old row. Never pruned. No foreign key to `workspaces`, so `delete_workspace` leaves it in place (and, by standard cascade semantics not covered by a repo test, adds a full-row DELETE entry per cascaded block). Only the trigger writes it. | `20260522062437_add_blocks_history.sql` |
| Storage `attachments` | Unencrypted bytes at `<ws>/<hex(sha256(plaintext))>`. The path itself confirms content to anyone who can guess the file. Nothing deletes these objects: there is no GC, and workspace delete doesn't touch Storage. | `20260625000000_add_attachments_storage.sql`, `src/sync/crypto/contentKey.ts`, `src/sync/byteTransform.ts` |
| Derived block ids | uuidv5 ids derived from keys that may include user text or values another party knows. Ids are plaintext in both modes, so these remain guess oracles after encryption. Not fixed by this conversion; full list in [§6](#6-what-stays-visible-afterwards). | as cited there |
| `workspaces.name` | Plain text in both modes. Synced and shown in invitations. | `src/data/workspaceSchema.ts` |

No other server table holds content. `public` has only `workspaces`, `workspace_members`, `workspace_invitations`, `blocks` and `blocks_history`. There are no edge functions, no pg_cron jobs and no workflows that copy content.

## 4. The invariant we relax

Today the mode can't change on either side:

- **Server:** `workspaces_prevent_e2ee_field_change` (`20260529120000_add_e2ee_workspace_columns.sql`) refuses every change to `encryption_mode` and `wk_canary`, with no role exception.
- **Client:** the local mode pin (`src/sync/keys/modePin.ts`) is set-once and throws on any change.

The conversion admits **exactly one transition**, `none → e2ee` with a well-formed canary, in two places:

- **Server.** Only the conversion's SECURITY DEFINER apply function may make it. The trigger admits it with the same `current_user in ('postgres', 'service_role')` check that the owner and `properties_migration` triggers already use (`20260820115000_workspaces_owner_is_not_client_writable.sql`). e2ee → none, and any canary change on an e2ee row, stay refused, so rotation remains future work.
- **Client.** `setModePin` stays set-once. A separate, narrowly named `upgradeModePinToE2ee` allows `plaintext → e2ee` only after a workspace key opens the server's canary.

**Why this doesn't weaken the pin.** The pin stops a server from *downgrading* a workspace (claiming e2ee → plaintext) to make a client upload plaintext. The opposite lie gains the server nothing:

- A server that falsely claims plaintext → e2ee can only stall that device ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)). The e2ee design already accepts that DoS.
- The canary seals the workspace id under AAD that names the workspace. So a canary copied from another e2ee workspace won't open, and the server can't trick a user into "unlocking" one workspace with another workspace's key.

## 5. Design

### 5.1 Server: freeze, stage, apply, abort

The server side (#1294) is a set of owner-only SECURITY DEFINER RPCs over a staging area in the `private` schema, which PostgREST doesn't expose:

- `private.workspace_conversions(workspace_id pk, state, started_by, started_at)`
- `private.workspace_conversion_rows(workspace_id, block_id, content, properties_json, references_json)`: the sealed columns only. The conversion only updates rows, so staging needs no op column, no inserts and no deletes.

**Every id is scoped to the workspace being converted.** These functions run with the definer's privileges and bypass RLS. A staged `block_id` whose server row is in any other workspace (or doesn't exist) is refused at stage time, and the apply's UPDATE is restricted to `workspace_id = ws`. Without that, a caller who owns workspace A could overwrite a block in workspace B by guessing its id.

1. **`begin_workspace_conversion(ws)`** freezes the workspace.
   - A BEFORE trigger on `blocks` refuses every write to a frozen workspace unless the definer makes it.
   - The refusal raises **`PT429`**. PostgREST turns that into HTTP 429, which `classifyUploadError` retries forever (`src/services/uploadErrorClassifier.ts`).
   - So other devices' queued edits stall rather than being quarantined. That is the same trick `blocks_refuse_anon` plays with `PT401` (`20261013120000_refuse_anon_writes_to_blocks.sql`). A 22/23/42/P0002 code would quarantine them.
2. **`stage_workspace_conversion(ws, rows)`** is chunked. Each row carries the sealed columns plus a **base**: `sha256` of each column's plaintext as the client read it.
   - The RPC compares each base with `sha256(convert_to(col, 'UTF8'))` of the current server row and refuses the chunk on any mismatch. All three columns are `text` on the server, so the bytes are the ones the client hashed.
   - **The base is checked and discarded. It is never stored.** An unkeyed plaintext hash left in staging, or in its dead tuples, would stay as a dictionary-testable fingerprint after the plaintext itself is gone.
   - The freeze is what makes a check at stage time enough. Nothing but the definer writes the workspace between stage and apply.
3. **`apply_workspace_conversion(ws, canary)`** runs as ONE transaction, with a raised `statement_timeout` (as `delete_workspace` has, `20260513205724_extend_delete_workspace_timeout.sql`):
   1. Check that the workspace has been frozen since staging began.
   2. Check completeness: the staged ids are exactly the workspace's block ids, **soft-deleted rows included**.
   3. Set `encryption_mode = 'e2ee'` and `wk_canary` **first**, so `blocks_require_ciphertext_for_e2ee` validates every row the next step writes.
   4. Update the three sealed columns from staging, `WHERE workspace_id = ws`, and check that the row count equals step 2's.
   5. `DELETE FROM blocks_history WHERE workspace_id = ws`. That includes the rows step 4 just wrote, whose `before_diff` holds the old plaintext.
   6. Clear the staging rows and the freeze.
4. **`abort_workspace_conversion(ws)`** clears the freeze and the staging rows. Nothing else has changed.

**What happens to timestamps.** The re-seal changes every row's content columns. So the clamp trigger raises `updated_at` to at least `OLD.updated_at + 1` on every row (`20260803000000_add_patch_base_version_drift_bump.sql`). That is intended:

- `updated_at` is the row version, and the bump is how peers know to re-download.
- What the user sees is `user_updated_at`; display reads it, not `updated_at`. The apply leaves it untouched, as it does `created_at`, `created_by` and `updated_by`.

**Why delete history inside the transaction instead of suppressing the history trigger.**

- The history trigger is SECURITY DEFINER, so `current_user` inside it can't tell the conversion apart from any other write.
- A bypass on a trigger that sits on every write across the whole fleet is a larger permanent risk than one extra delete in a function that runs once per workspace.
- The cost is transient: history rows are written and then deleted, leaving dead tuples. Step 8 of the runbook ([§7](#7-runbook)) vacuums them.

### 5.2 Client: a plaintext-pinned device that sees e2ee

Today `getMaterializability` returns `copy` for any workspace pinned plaintext, whatever the server says (`src/sync/keys/resolver.ts`). After a conversion, such a device would:

- write `enc:v1:` strings into `blocks` and into its FTS and alias indexes;
- upload plaintext edits, which the ciphertext trigger rejects permanently.

That isn't a leak, since the server refuses those edits. But the device is broken, and its edits are lost to quarantine.

The change (#1293) applies when the synced `workspaces` row says `e2ee` but the pin says `plaintext`:

| | Today | After |
|---|---|---|
| Materialize | `copy` | `defer`: rows stay staged in `blocks_synced`, and the local `blocks` keep their plaintext |
| Upload | unsealed | **held** for that workspace; nothing is sent |
| UI | — | unlock prompt (paste the workspace key) |

The conversion only updates rows, so it sends locked peers no deletes. A deferred peer therefore keeps every block it had, unchanged, until it unlocks.

**Upgrading the pin.** Once a key opens the server canary, the existing `unlockWorkspaceWithKey` checks run, followed by `upgradeModePinToE2ee`.

- A device whose key store already holds a key that opens the canary upgrades without asking. That covers the converting device, and one that crashed after the apply.
- On upgrade, every staged `blocks_synced` row of the workspace is marked for re-apply. That repairs a device that ran an older build across the conversion and already copied ciphertext into `blocks`.
- The held uploads then drain, sealed, because `encryptUploadColumns` resolves the mode per op at upload time. A content-only patch is accepted at that point, since every server row already has all three columns sealed.

**The upload queue is FIFO.** PowerSync uploads a device's transactions in order, so holding one op stalls everything queued behind it on that device. The unlock prompt is what clears it.

This must be deployed to every device **before** any conversion runs.

**Known gap: an edit made during the window.**

- During the freeze, another device's plaintext edit gets `PT429` and retries.
- The workspace row's mode change arrives in the same large checkpoint as every resealed block. That device's next retry can land before it learns the workspace is e2ee.
- If it does, the ciphertext trigger refuses the edit with a permanent code and quarantines it (in `ps_crud_rejected`, still on that device).
- **Recovery:** after the device upgrades, **Retry** in the System Status rejection dialog re-queues the edit, and the upload path seals it under the now-e2ee mode.
- The runbook's "drain every queue, pause editing elsewhere" ([§7](#7-runbook)) keeps this off the normal path.

Making the ciphertext trigger's refusal transient instead would close the gap. It would also make a genuinely buggy client jam its whole queue forever, so that trade is declined.

### 5.3 The sealed image (pure)

`buildSealedImage(serverRows, wk) → {stagedRows}` (#1292). Its input is the workspace as this device's `blocks_synced` holds it: the server image, every row, soft-deleted rows included.

1. **Seal** each row's three content columns with the existing envelope and AAD (`encodeForWire`). Ids, `parent_id`, ordering and timestamps are untouched.
2. **Compute the bases** for [§5.1](#51-server-freeze-stage-apply-abort): `sha256` of each column's plaintext. They are sent with the staged chunk and never persisted on the client either.

**Correctness oracle** (property test): open every staged row under the key and compare with the input. The two must be equal exactly.

**Sizing** (an estimate, not measured):

- base64url adds a third;
- each sealed column adds a 12-byte nonce, a 16-byte tag and the `enc:v1:` prefix;
- so the staged image is about 1.33× the plaintext, plus about 135 bytes per row.

Every row changes, so every device re-downloads the whole workspace afterwards.

### 5.4 Attachments

For every media block, soft-deleted ones included (#1291):

1. Obtain the plaintext bytes from the local byte store, or download them.
2. Seal them under the workspace key.
3. Upload them to `<ws>/<HMAC(K_id, sha256)>`.

The keyed-path and sealing logic already exists, in `src/sync/crypto/contentKey.ts`, `src/sync/byteTransform.ts` and the upload drain `src/plugins/attachments/uploadDrain.ts`. Reuse it, including the drain's handling of an **occupied path**:

- Paths are write-once and Storage is untrusted, so an object already at the destination is fetched, decoded and hash-verified before it counts as done.
- Its `encb:v1:` header alone proves nothing, because a well-formed poisoned object has one too.
- A mismatch is reported, not accepted.

**Media block ids don't change.** The app derives an attachment's Storage path from the block's `media:hash` plus the workspace mode and `K_id`, and does not store it. So after the conversion, an existing media block reads its bytes from the keyed path. Two consequences:

- The local byte store on each device is keyed by the old sha256 content key. It needs re-keying (or a re-download) for the converting device to render from cache.
- Re-capturing a file that was captured before the conversion mints a second media block, at the keyed id. That is accepted. The sha256-derived ids that stay are listed in [§6](#6-what-stays-visible-afterwards).

**Ordering.**

1. Upload and verify every keyed object **before** the apply, so no media block ever points at missing bytes.
2. Delete every non-envelope object under `<ws>/` only **after** the apply commits. That covers the known sha256 paths and any orphan found by listing the prefix.
3. Then run the existing ciphertext audit (`src/plugins/attachments/audit/`). It lists every object of an e2ee workspace and flags any non-envelope one, so a clean audit proves the prefix holds no plaintext.

The 6-hourly audit workflow will flag the workspace between the apply and the deletion. That's expected.

### 5.5 History: archive, then purge

The server's `blocks_history` for the workspace is plaintext and must go. Nothing in the app reads it: the `block_history` tool reads local `row_events` (`src/plugins/agent-runtime/changeHistory.ts`), and only `scripts/supabase-health.mjs` reads the server table. So:

- **Archive after the freeze.** Once the workspace is frozen, nothing new can be written to its history. The converting client then exports the workspace's `blocks_history` (members can SELECT it under RLS) as chunks sealed under the workspace key, and the user keeps the file offline.
  - An export taken before the freeze could miss an edit landing in the gap, which the apply would then delete for good.
  - No plaintext copy is ever written to disk, and the archive is useless without the key.
- **Purge** inside the apply ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Later, if wanted.** Block ids don't change, so a future importer could re-seal archived values under the same per-(block, workspace, column) AAD and insert them through an owner-only RPC. That would turn the archive back into encrypted server history. Re-sealing history in place now would mean building that importer before anything reads its output, so it is deliberately left for later.

Local `row_events` is device-local, never synced, and keyed by block id. Since no id changes, it stays intact on every device.

### 5.6 Flow and failure paths

The orchestrator (#1290) refuses to start unless:

- the user owns the workspace;
- the local upload queue is drained;
- no rejected rows are pending for the workspace.

| Step | If it fails | State left behind | Recovery |
|---|---|---|---|
| 1. Generate the workspace key, reveal it once and require a retype. Store it in the key store **before** any server change | before anything else | nothing changed | retry |
| 2. Freeze | RPC error | not frozen | retry |
| 3. Export the sealed history archive | download error | frozen; other devices' edits held | retry, or abort |
| 4. Wait for `blocks_synced` to reach a checkpoint taken after the freeze, then build the sealed image | crash | frozen | resume, or abort |
| 5. Upload and verify keyed attachment objects | partial, or a verification mismatch | extra ciphertext objects (harmless) | resume (the occupied-path check makes it idempotent); investigate any mismatch |
| 6. Stage chunks | base mismatch | frozen, partly staged | the client read a pre-freeze state, so re-read and re-stage; or abort |
| 7. Apply | refusal or timeout | the transaction rolls back; still frozen | fix the cause and re-apply, or abort |
| 8. Upgrade the local pin | crash after the apply | server e2ee, pin still plaintext | automatic on restart: the stored key opens the canary ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)) |
| 9. Delete every non-envelope object under `<ws>/` | partial | plaintext objects remain | resume; report |
| 10. Verify: every row opens, the ciphertext audit is clean, zero history rows remain | a check fails | converted | investigate; nothing is lost while the key is held |

**Losing the key after the apply** makes the server copy unrecoverable. Devices that still hold plaintext `blocks` defer instead of copying, and receive no deletes ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)). Their local plaintext survives and can be exported, but that is a last line of defence, not a plan. Store the key in two independent places before step 2.

## 6. What stays visible afterwards

The design's accepted metadata (§15), unchanged here:

- tree shape and ordering;
- timestamps, including the original creation dates this conversion deliberately keeps;
- edit timing, authorship and `deleted` flags;
- ciphertext lengths;
- `workspaces.name`, which should be renamed in the runbook if it is sensitive.

**Derived ids stay as they are, and some of them remain guess oracles.** Anyone who knows or can enumerate a key can hash it under the public namespace and look for the row. The kinds known today:

| Kind | Key | Who can test it |
|---|---|---|
| Alias seats (`src/data/targets.ts`) | page name | anyone who guesses a name. Open for every e2ee workspace (#719). A seat keeps the hash of the name it had when it was minted, even after a rename. |
| Media blocks (`src/plugins/attachments/mediaCapture.ts`) | sha256 of the file | anyone holding the file |
| Daily notes (`src/plugins/daily-notes/dailyNotes.ts`) | ISO date | anyone (enumerable), which reveals which days have a note |
| Roam import (`src/plugins/roam-import/blockIds.ts`) | Roam uid | holders of the source graph |
| Extension records via `pluginBlockId` / derived identities | whatever the extension chose: external ids (Readwise `user_book_id` and highlight ids, `agent-extensions/readwise.tsx`; Matrix event ids, `agent-extensions/matrix-chat-client.tsx`) and user-chosen keys (Strength Tracker dates and group keys, `agent-extensions/strength-tracker/src/km/store.ts`) | the external service, or anyone who knows the value |
| Kernel pages, definition seeds, the user page, state children | code-owned constants and ids | anyone. Reveals which features and plugins are used, not what the user wrote |

**Why the conversion doesn't re-id them.** It would have to give each such block a new id: delete the old row, insert a new one, and rewrite every pointer. That turns a pure re-seal into a migration with its own failure modes:

- **Locked peers lose blocks.** The sync observer hard-deletes a removed id once its staging row is gone, without waiting for the replacement row it has deferred (`src/data/internals/syncObserver/materialize.ts`). A device that hasn't unlocked yet would lose the old plaintext blocks and keep nothing in their place.
- **Old links and history break.** Saved `#<ws>/<old id>` links, and other devices' `row_events` under the old ids, need a durable old→new lookup.
- **The leftover can't be measured.** A seat whose original name appears in no history can't be told apart from any other uuidv5 id. So the leftover can only be reported as "matched N; unknown remainder", never as an exact count.
- **Extension keys need an owner to judge them.** A kernel classifier can't know which extension keys are sensitive; each extension that owns a key has to decide.

All of that applies equally to the existing e2ee workspace. So it belongs to one re-id migration for every e2ee workspace (#1297), which waits on #719's namespace fix, not to this conversion. #1297 records the four failure modes above as requirements.

Until then, the runbook waits for #719's namespace fix, so that new `[[links]]` stop minting public ids. Pages and files that predate the conversion stay testable.

## 7. Runbook

The first production run is tracked in #1288.

**Before:**

1. **#719 has shipped.** Otherwise every new page linked after the conversion mints another page-name oracle.
2. **Key custody.** Store the workspace key in two independent places, for example a password manager and paper.
3. **Backup.** Take a full local SQLite export with the raw-SQLite export action (`src/utils/exportSqliteDb.ts`). It is plaintext, so keep it encrypted offline. This export is the rollback.
4. **Fleet.** Every device runs a build with #1293, or is wiped (the browser's "clear site data"). Every device's upload queue is drained, and editing on other devices pauses for the duration.
5. **Ordering.** Leave the workspace on the `cell` properties model until afterwards.
   - Property-definition synthesis runs only during the properties-as-blocks switch (`src/plugins/properties-migration/action.ts`), and on an e2ee workspace it mints K_id-keyed ids (`resolveSynthesisNamespace` in `src/data/internals/propertyDefinitionSynthesis.ts`).
   - Switching first would mint public, name-derived definition ids.
6. Run the flow from a desktop: the device with the most attachment bytes stored locally.

**After:**

7. Verification passes ([§5.6](#56-flow-and-failure-paths) step 10). Other devices paste the key and upgrade.
8. **Operator: `VACUUM FULL`.**
   - Run it on `blocks`, `blocks_history`, `private.workspace_conversion_rows` and `storage.objects`.
   - The apply and the purge leave plaintext in dead tuples, and Storage metadata rows held the old sha256 paths.
   - It takes an exclusive lock, so expect a short write stall across the fleet.
9. **Operator: drop leftover ad-hoc tables** from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`) if they still exist. They hold ids and timestamps, not content.
10. **Act on #1289's findings** and record the workspace's "safe from" date ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).

## 8. Platform residue, and when it is "safe if breached"

These copies live outside the repo's reach, so none of them is verified here. #1289 confirms each, with its source:

- **Supabase daily backups, PITR and WAL archives** hold plaintext until they age out. Early deletion is probably impossible.
- **Postgres error logs.** Constraint failures can print "Failing row contains (…)".
- **Storage.** Whether deleted objects are versioned or soft-deleted at the storage layer.
- **PowerSync Cloud bucket storage.** It likely keeps superseded operations with full row data until compaction. Open questions: can compaction be forced, and does deploying changed sync rules reprocess from scratch?

So the honest claim has two parts:

- **The live systems.** Once the conversion commits, deletes the old objects and vacuums, a breach of the **live** database, Storage or sync service exposes only ciphertext and the metadata in [§6](#6-what-stays-visible-afterwards).
- **The backups.** A breach of a **backup** is safe only after the longest retention window above has passed since then. The runbook records that date.

## 9. What the workspace gives up

- **Server-side anomaly detection.** The L5 detectors in `scripts/supabase-health.mjs` are documented as plaintext-only, so they go blind for this workspace.
- **The consistency check**, until it is fixed (#233).
- **Any future server-side feature**, such as search, AI, or server-rendered and anonymous share links (`docs/e2ee-design.html` §10/§15).
- **Recovery.** A lost key loses the server copy.
- **Bandwidth, once.** Every device re-downloads the whole workspace.

## 10. Relation to workspace-key rotation

Rotation (`docs/e2ee-design.html` §14, unbuilt) needs four of this conversion's steps:

- re-seal every row;
- set a new canary through a privileged path;
- remove or re-seal history sealed under the old key;
- re-upload attachments under the new K_id's paths.

It also needs the re-id migration of [§6](#6-what-stays-visible-afterwards) (#1297), because K_id-derived ids (synthesized definitions, keyed media ids, and alias seats once #719 lands) all change with K_id.

Plaintext → e2ee is that operation starting from "no key". So the freeze / stage / apply RPCs, the sealed-image builder and the attachment pass should be written over a *source* key that may be absent, not with "plaintext" hard-coded. Rotation then adds one admitted transition (`e2ee → e2ee` with a new canary) and a decrypt step, instead of a second machine. Rotation itself is deliberately not built here.

## 11. Alternatives considered

- **Export → new e2ee workspace → import.** Rejected, see [§2](#2-decision-convert-in-place-not-by-copy). It would keep an untouched fallback workspace, but the runbook's full local export provides the same rollback.
- **Re-iding user-text-derived ids during the conversion.** Moved to #1297, see [§6](#6-what-stays-visible-afterwards). It would save one pass over the affected rows, at the cost of delete/insert pairs, broken links, and a leftover nobody can count, all inside a migration that otherwise only updates.
- **Gradual re-upload through the normal patch path, with no freeze.** Rejected:
  - The ciphertext trigger checks the whole new row, so once the mode flips, an ordinary content-only edit to a row that hasn't been re-sealed yet is rejected.
  - Without the flip, plaintext-pinned peers keep uploading plaintext.
  - Either way, every device sees mixed states.
- **Persisting the bases and re-checking them at apply time.** Rejected. The freeze already guarantees nothing changes between stage and apply, and stored unkeyed plaintext hashes would outlive the plaintext ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Suppressing the history trigger during the apply.** Rejected in favour of deleting inside the transaction ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Wiping every other device instead of the pin upgrade.** Still available per device in the runbook. It doesn't replace #1293, because an old or offline device must never treat ciphertext as content.
- **Re-sealing server history in place now.** Deferred ([§5.5](#55-history-archive-then-purge)).

## 12. Tracking

| Piece | Issue | Waits on |
|---|---|---|
| Epic | #1295 | — |
| Server freeze/stage/apply RPCs and the one-way mode admit | #1294 | — |
| Plaintext-pinned device sees e2ee: defer, hold, one-way pin upgrade | #1293 | — |
| Sealed-image builder | #1292 | — |
| Attachment re-seal | #1291 | — |
| Orchestrating flow | #1290 | #1291, #1292, #1293, #1294 |
| Platform retention spike | #1289 | — |
| First production run (runbook) | #1288 | #719, #1289, #1290, #1293 |
| Re-id migration for user-text-derived ids, every e2ee workspace | #1297 | #719 |
