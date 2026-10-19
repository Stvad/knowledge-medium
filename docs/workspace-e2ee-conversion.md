# In-place plaintext → E2EE workspace conversion

> **Status:** proposal — nothing here is built. Last verified against code: 2026-10-18 (master `13d3f0dc72`).
> Tracking: epic #1295. Child pieces are listed in [§12](#12-tracking).

## 1. Goal

Make an existing plaintext workspace end-to-end encrypted and keep everything the user has built:

- every block id, so every `((id))`, ref property, backlink and URL keeps working;
- the user-visible timestamps (`created_at`, `user_updated_at`) and authorship;
- extension approvals;
- the device-local change history.

When the conversion finishes, nothing on the backend holds the workspace's *content* in plaintext. A breach of the database, Storage or the sync service then yields only ciphertext plus the metadata in [§6](#6-what-stays-visible-afterwards).

The conversion only re-seals. It changes no block id, including the derived ids that hash user text; those go to a separate migration ([§6](#6-what-stays-visible-afterwards), #1297).

Non-goals:

- **e2ee → plaintext.** That stays impossible.
- **Workspace-key rotation.** It isn't built here ([§10](#10-relation-to-workspace-key-rotation)).
- **Re-iding derived blocks.** That's #1297.

## 2. Decision: convert in place, not by copy

`docs/e2ee-design.html` §10 says that crossing modes means *export + create a new workspace + import*. For a workspace with years of history, that path loses most of what makes it worth keeping.

- **Block ids can't survive a copy.**
  - `blocks.id` is the primary key on its own, both on the server (`supabase/migrations/20260510222352_consolidated_initial.sql`, `blocks_pkey`) and locally (`src/data/blockSchema.ts`). So an id can exist in only one workspace.
  - A copy would have to re-id every block and rewrite every `((id))` / `!((id))` / `[label](((id)))`, every ref and refList value, every `references_json` entry and every `parent_id`.
  - No code does that today. The only existing import also drops properties and timestamps (#401).
- **History can't follow a copy.** Clients can't insert into `blocks_history`; only its trigger writes it. Local `row_events` is keyed by block id.
- **Everything keyed by workspace id or block id breaks:** URLs, extension approvals (keyed by extension block id, per device) and membership.

In place, all of that is kept. Ids don't change, so the AAD that binds each sealed column needs no rebinding. That AAD covers block id, workspace id, column and schema version (`contentAad` in `src/sync/crypto/aad.ts`). The cost is one exception, in one direction only, to the rule that the encryption mode is immutable ([§4](#4-the-invariant-we-relax)).

## 3. What the backend holds for a plaintext workspace today

This is the purge checklist. It was verified in the repo, except for the platform-level copies, which are in [§8](#8-platform-residue-and-when-it-is-safe-if-breached).

| Surface | What it holds | Source |
|---|---|---|
| `blocks` | `content`, `properties_json` and `references_json` in plaintext. Soft-deleted rows keep their content forever. | consolidated initial migration |
| `blocks_history` | INSERT rows hold the full row. UPDATE rows hold the old and new value of every changed column. DELETE rows hold the full old row. Never pruned, and only the trigger writes it. There is no foreign key to `workspaces`, so `delete_workspace` leaves these rows behind. | `20260522062437_add_blocks_history.sql` |
| Storage `attachments` | Unencrypted bytes at `<ws>/<hex(sha256(plaintext))>`. The path itself confirms the content to anyone who can guess the file. Nothing deletes these objects: there is no GC, and workspace delete doesn't touch Storage. | `20260625000000_add_attachments_storage.sql`, `src/sync/crypto/contentKey.ts`, `src/sync/byteTransform.ts` |
| Derived block ids | uuidv5 ids whose keys may include user text or values someone else knows. Ids are plaintext in both modes. Not fixed here ([§6](#6-what-stays-visible-afterwards)). | as cited in §6 |
| `workspaces.name` | Plain text in both modes. Synced, and shown in invitations. | `src/data/workspaceSchema.ts` |

No other repo-defined table holds content. Migrations define `workspaces`, `workspace_members`, `workspace_invitations`, `blocks` and `blocks_history` in `public`. There are no edge functions, no pg_cron jobs and no workflows that copy content. Ad-hoc tables left by past scripts hold ids and timestamps only ([§7](#7-runbook)).

## 4. The invariant we relax

Today the mode can't change on either side:

- **Server:** `workspaces_prevent_e2ee_field_change` (`20260529120000_add_e2ee_workspace_columns.sql`) refuses every change to `encryption_mode` and `wk_canary`, with no role exception.
- **Client:** the local mode pin (`src/sync/keys/modePin.ts`) is set-once, and changing it throws.

The conversion admits **exactly one transition**, `none → e2ee` with a well-formed canary.

- **Server.** Only the conversion's apply may make that transition. The trigger admits it when `current_user = 'postgres'` **and** the transaction-local `km.conversion_attempt` equals a live attempt for that workspace ([§5.2](#52-the-freeze)). `current_user` alone would admit every SECURITY DEFINER function and every service-role session. e2ee → none and any canary change on an e2ee row stay refused.
- **Client.** `setModePin` stays set-once. A separate, narrowly named `upgradeModePinToE2ee` allows `plaintext → e2ee`, and only after a workspace key opens the server canary ([§5.6](#56-clients)).

**Why this doesn't weaken the pin.** The pin exists to stop a server from *downgrading* a workspace (claiming e2ee → plaintext) so that a client uploads plaintext. The opposite lie gains the server nothing:

- A false plaintext → e2ee claim can only stall a device. The e2ee design already accepts that kind of DoS.
- The canary seals the workspace id under AAD that names the workspace. So a canary copied from another e2ee workspace won't open, and the server can't get a user to "unlock" one workspace with another workspace's key.

## 5. Design

### 5.1 The attempt

One conversion attempt is the unit of everything. Its server row is the durable state, and every client step is idempotent and keyed by the attempt, so a crash resumes from what the server says. #1294 builds it: owner-only SECURITY DEFINER RPCs over tables in the `private` schema, which PostgREST doesn't expose.

```
begin ──▶ staging ──apply──▶ applied ──purge──▶ cleanup_pending ──finish──▶ (done)
             │                  │  ▲                    │
           abort             re-apply                abandon (key lost only)
             ▼               (repair)                   ▼
          (gone)                                     (gone)
```

The workspace is **frozen** while an attempt row exists ([§5.2](#52-the-freeze)). The `applied` state can also be abandoned.

Tables:

- **`private.workspace_conversions(workspace_id pk, attempt_id, canary, state, started_by, started_at)`.** `canary` is the new key's canary. The client mints it before `begin`, and storing it here binds the attempt to exactly one key.
- **`private.workspace_conversion_rows(workspace_id, attempt_id, block_id, content, properties_json, references_json, verify_record)`.** The sealed columns, plus a sealed per-row verification record ([§5.3](#53-sealing-apply-verification)). The conversion only updates rows, so there's no op column. The purge clears it.
- **`private.workspace_conversion_objects(workspace_id, attempt_id, keyed_path, verified)`.** Every attachment object the cleanup writes, recorded **before** it is written ([§5.5](#55-attachments)). The names are keyed HMACs, so storing them adds no fingerprint.

Rules that apply to every RPC:

- **Scoped to the workspace.** These functions bypass RLS. A staged `block_id` whose row is in another workspace, or doesn't exist, is refused, and every UPDATE is restricted to `workspace_id = ws`. Otherwise an owner of workspace A could overwrite a block in B by guessing its id.
- **Serialized on the attempt row.** Every RPC that takes an `attempt_id` starts with `SELECT … FOR UPDATE` on the attempt row for `ws`. It refuses if the row is missing, holds another `attempt_id`, or isn't in an allowed state. That stops two owner tabs from interleaving `apply` with `abort`. The row-count check on each state change is defence in depth, since the lock and the state check already pin the row.
- **Reads never refuse or wait.** `get_workspace_conversion` and `workspace_upload_mode` take no `attempt_id`. They read the committed row with a plain `SELECT`, which doesn't block on a row lock, and they answer "no attempt" when there is none.

| RPC | From state | To state | Effect | Refuses when |
|---|---|---|---|---|
| `begin_workspace_conversion(ws, canary) → attempt_id` | no attempt | `staging` | takes the serialization locks of [§5.2](#52-the-freeze), including `FOR UPDATE` on the `workspaces` row so a `properties_migration` flip can't straddle it, then inserts the attempt (freezing the workspace) | an attempt exists; `encryption_mode ≠ 'none'` (checked in this transaction); caller isn't the owner |
| `stage_workspace_conversion(ws, attempt_id, rows)` | `staging`, `applied` | same | checks each row's per-column base against the current row, then **discards** the base and upserts the sealed columns ([§5.3](#53-sealing-apply-verification)) | foreign or missing `block_id`; base mismatch |
| `apply_workspace_conversion(ws, attempt_id)` | `staging`, `applied` | `applied` | flips the mode and re-seals in one transaction ([§5.3](#53-sealing-apply-verification)); re-running it in `applied` re-applies re-staged rows | incomplete image; a non-envelope column |
| `purge_workspace_history(ws, attempt_id, archived_count)` | `applied` | `cleanup_pending` | deletes the workspace's `blocks_history`, and clears staging ([§5.4](#54-history-archive-verify-purge)) | `archived_count` ≠ the frozen server count |
| `list_workspace_objects(ws, attempt_id, after_name, limit)` | `cleanup_pending` | same | keyset page of `storage.objects` (bucket `attachments`, name under `<ws>/`, nested names included, `name > after_name` ordered by name) ([§5.5](#55-attachments)) | — |
| `record_conversion_object(ws, attempt_id, keyed_path, verified)` | `cleanup_pending` | same | records an object before it's written; never downgrades `verified` | — |
| `finish_workspace_conversion(ws, attempt_id)` | `cleanup_pending` | done | deletes the attempt and its recorded objects, ending the freeze | — |
| `abort_workspace_conversion(ws, attempt_id)` | `staging` | gone | deletes the attempt and staging, ending the freeze. Nothing has been written to blocks or Storage yet. | — |
| `abandon_workspace_conversion(ws, attempt_id)` | `applied`, `cleanup_pending` | gone | key-loss exit only: ends the freeze without finishing, so the recovery procedure ([§7](#7-runbook)) can run | — |
| `get_workspace_conversion(ws)` | any | — | owner read: `attempt_id`, `canary`, `state` | — |
| `workspace_upload_mode(ws)` | any | — | member read: `frozen` while an attempt exists, otherwise `none` or `e2ee` | — |

While an attempt exists, two other server paths refuse:

- `delete_workspace` says "finish, abort or abandon the conversion first". It runs as `postgres` (SECURITY DEFINER), so without this check its cascade would also slip past the freeze.
- The `properties_migration` flip trigger refuses, and the properties-migration gesture refuses before synthesis. Otherwise a mid-conversion switch would mint public, name-derived definition ids ([§6](#6-what-stays-visible-afterwards)).

### 5.2 The freeze

The freeze holds from `begin` until `finish`, `abort` or `abandon`. It is enforced on both write surfaces, and serialized against writes already in flight.

**Block writes.**
- A BEFORE trigger on `blocks` refuses every write to a frozen workspace except the apply's own, raising **`PT429`**. PostgREST turns that into HTTP 429, which `classifyUploadError` retries (`src/services/uploadErrorClassifier.ts`), the same trick `blocks_refuse_anon` plays with `PT401`. A 22/23/42/P0002 code would quarantine the write instead.
- "The apply's own" means `current_user = 'postgres'` **and** `km.conversion_attempt` equal to the live `attempt_id`. Only `apply` sets that, with `set_config(…, true)`. PostgREST clients can't be `postgres` and can't call `set_config`, so the pair can't be forged.
- **Trigger order matters.** Postgres fires same-event BEFORE triggers in name order. The freeze trigger's name must sort before `blocks_require_ciphertext_for_e2ee_trg`. Otherwise a lagging device's plaintext write during `cleanup_pending` gets 23514 (quarantine) instead of 429 (stall). pgTAP pins this in both `staging` and `cleanup_pending`.

**Attachment inserts.** This is the fence rule; other sections point here.
- Each upload declares the mode it was encoded under, in its Storage metadata as `kmMode`. storage-js sends that as `x-metadata`, and it's stored as `user_metadata`.
- The `attachments` INSERT policy calls `private.attachment_insert_admitted(ws, kmMode)`. Under a frozen or e2ee workspace it **admits only `kmMode = 'e2ee'`**, and a missing field counts as plaintext.
- That fails closed for any build that predates the declaration, including a member who accepts an invitation mid-conversion on a cached build. So membership needs no freeze of its own.
- The cleanup's keyed uploads declare `e2ee`.
- The client also checks before uploading ([§5.6](#56-clients)). That check doesn't provide the guarantee; it keeps uploads from being refused needlessly.

**Serializing `begin` against writes already in flight.** A write whose check read a snapshot from before the attempt existed could otherwise commit after `begin`, behind a stage check or cleanup listing that had already run.
- **Blocks.** `begin` takes `LOCK TABLE public.blocks IN SHARE MODE` (with a `lock_timeout`, retried). SHARE conflicts with every writer's ROW EXCLUSIVE lock, so `begin` waits for in-flight block writes and new ones wait for `begin`. When they resume, their trigger reads the freeze in a fresh read-committed snapshot.
- **Storage.** `attachment_insert_admitted` first takes `pg_advisory_xact_lock_shared(<ws key>)`, and `begin` takes the exclusive one. That makes the wait per-workspace and costs one advisory lock per attachment insert. There's no table lock on `storage.objects`, which would pause uploads to every workspace.
- **Cost.** A fleet-wide block-write pause lasting as long as `begin`'s transaction, once per conversion. A per-write advisory lock on `blocks` was rejected because it would cost every write forever.

**Premises to verify first (#1294).** All of them are Storage internals the repo can't show:
- the INSERT policy sees the request's `user_metadata`;
- a policy may call a SECURITY DEFINER function that takes an advisory transaction lock;
- that lock lasts until the object row commits.

If any premise fails, the fallback is a separate bucket for e2ee-mode objects, with `begin` serializing on the plaintext bucket. That is heavier, because the existing e2ee workspace's objects would have to move.

**How long it lasts.** From `begin` to `finish`, the run covers:
- the snapshot;
- the history archive;
- staging, apply and verification;
- the purge;
- the attachment cleanup, which downloads and re-uploads every raw object.

For a large workspace with many attachments that can take **hours**, not minutes. Other devices' writes to the workspace are parked rather than stalling their whole upload queue (#1301, [§5.6](#56-clients)). A crash leaves the workspace frozen until an owner device resumes it ([§5.8](#58-flow-resume-failure-paths)).

### 5.3 Sealing, apply, verification

**Sealing** (#1292). `sealChunk(rows, wk) → stagedChunk` is a pure function over one bounded page. The orchestrator pages through this device's `blocks_synced`, which is the server image: every row of the workspace, soft-deleted ones included. For each page it reads, seals, verifies, stages, and releases. Neither the plaintext nor the ciphertext image is ever held in memory whole.
- Seal the three content columns with the existing envelope and AAD (`encodeForWire`). Ids, parent, order and timestamps are untouched.
- Open every sealed column under the attempt's key before staging, so a page sealed under another key never reaches the server.
- The **base** is `sha256` of each column's wire value as read: plaintext now, old-key ciphertext under rotation, and ciphertext again for a repair re-stage.
  - The stage RPC compares it with `sha256(convert_to(col, 'UTF8'))` of the current row. All three columns are `text`.
  - The base is **discarded, never stored**. An unkeyed plaintext hash left in staging or in dead tuples would remain a dictionary-testable fingerprint.
  - A check at stage time is enough because nothing but the apply writes the workspace after `begin`.

**Apply** runs as one transaction, with a raised `statement_timeout`, as `delete_workspace` has:
1. Lock the attempt and check its state, then set `km.conversion_attempt`.
2. Check completeness: the staged ids are exactly the workspace's block ids, **soft-deleted rows included**.
3. Set `encryption_mode = 'e2ee'` and `wk_canary`, taken from the **attempt's stored canary** and never from a parameter. This comes **first**, so `blocks_require_ciphertext_for_e2ee` validates every row written next.
4. Update the three sealed columns from staging, `WHERE workspace_id = ws`. A row-count check against step 2 is defence in depth.
   - The history trigger **skips these writes**, because it sees the attempt-scoped `km.conversion_attempt`.
   - That avoids a transient plaintext-plus-ciphertext history copy that MVCC and WAL wouldn't reclaim before a vacuum.
   - The setting is narrow, since only the apply sets it.

History is **not** purged here. The plaintext's last server copy goes only after verification.

**Verification before anything irreversible.**
- **What it compares against.** As each page is staged, the converting device writes a per-row **verification record** of what it sealed:
  - the base of each sealed column;
  - the invariant columns: `parent_id`, `order_key`, `deleted`, `created_at`, `user_updated_at`, `created_by`, `updated_by`;
  - `updated_at`.

  - **It's sealed under the workspace key and staged with the row** as `verify_record`, with AAD binding block id, workspace id and the label `verify`.
    - So any key holder can verify, including a device that takes over an `applied` attempt after the converting device crashed.
    - The server can't read it, so the plaintext hashes inside are no fingerprint.
    - The purge deletes it along with the staging rows.
  - **Why not compare against live local `blocks` rows:** `setReadOnly` still lets UI-state and preference writes through ([§5.8](#58-flow-resume-failure-paths)), a sync gap can leave a local row stale, and a takeover device may not hold the plaintext at all.
- **The comparison.** The device keeps its pin plaintext, so the resolver defers instead of copying ([§5.6](#56-clients)). It waits for a checkpoint that covers the apply, then decrypts every row of the workspace straight out of `blocks_synced`, without going through materialization. For each row it checks:
  - `sha256` of each decrypted column equals the record's base;
  - every invariant column equals the record's value;
  - `updated_at` is **greater** than the record's, since the clamp's bump is expected.
- **Repair.** A row that fails to open or doesn't match is repaired while the attempt is still `applied`: re-stage it, with the base over its current ciphertext, then re-run `apply`.
  - The plaintext comes from this device's local `blocks` row, if that row's hashes equal the record's bases. Otherwise it comes from the content-recovery snapshot, which was taken at the same point.
  - A takeover device without either stays in `applied` and says so. The verification gate is never weakened.
  - A repaired row bumps `updated_at` again, which the "greater than" check allows, so verification can converge.
- Only a clean pass proceeds to the purge. This catches the bugs a client-side seal check can't: a row or column mapping error in the stage RPC, its upsert, or the apply's `UPDATE … FROM`. The AAD binds the column, so a swapped column would pass the envelope trigger and then fail to open everywhere.

**Timestamps.** The re-seal changes every row's content columns, so the clamp raises `updated_at` to at least `OLD.updated_at + 1` (`20260803000000_add_patch_base_version_drift_bump.sql`). That's intended: `updated_at` is the row version, and the bump makes peers re-download. Display reads `user_updated_at`, which the apply leaves untouched, as it does `created_at`, `created_by` and `updated_by`. The local-history side of the bump is in [§5.6](#56-clients).

**Disk.** Postgres can't see free disk, so this is an operator check ([§7](#7-runbook)). The apply's peak is roughly **5.5×** the content columns:
- staging, about 1.33×;
- the new row versions, about 1.33×;
- WAL for both, about 2.7×.

On top of that, the replication slot keeps WAL until PowerSync has consumed the apply, and the later `VACUUM FULL` writes its own copy.

### 5.4 History: archive, verify, purge

The server's `blocks_history` for the workspace is plaintext and must go. Nothing in the app reads it: the `block_history` tool reads local `row_events` (`src/plugins/agent-runtime/changeHistory.ts`). But it is the only server-side record of years of edits, and of any block hard-deleted out of band. So the archive must be **proved** saved and readable before the purge.

- **Export after the freeze.** Nothing new can be written to the history once the workspace is frozen.
  - Members can SELECT `blocks_history` under RLS. Page by an ascending `event_id` cursor, never by offset or a single capped response.
  - Seal each chunk under the workspace key, then end with a sealed **trailer** holding the total count and a hash chain over the chunks, so a truncated file is detectable.
  - Write through a File System Access handle, or stage in OPFS and then download.
- **Read it back.** Re-open the persisted file, decrypt every chunk, check the chain against the trailer, and check the count against the server's `count(*)`. The count passed to `purge_workspace_history` comes **from this read-back**, never from the export loop. A cancelled Save dialog, a full disk or a dead download therefore fails before anything is deleted.
- **Resume and takeover redo the export** unless this device can re-open and verify an archive of its own. A device that took over never trusts another device's archive.
- **The decoder ships with the export** (#1290). It's the same module's read path, with a round-trip test. The runbook keeps the archive alongside the key copies.
- **Later, if wanted.** Block ids don't change, so a future importer could re-seal archived values under the same per-column AAD and insert them through an owner-only RPC. That would turn the archive back into encrypted server history. It is deliberately not built now.

Local `row_events` is device-local and keyed by block id, so it stays intact on every device.

### 5.5 Attachments

The attachment pass (#1291) runs only after the purge. The workspace is then `cleanup_pending`: still frozen, already e2ee.

There is no upload phase before the apply. The cleanup below converts every raw object whether or not a block names it, so an earlier phase would only shorten a window, inside the freeze, in which an upgraded device without local bytes sees a fetch miss. The down-lane re-attempts missing objects on its own (`src/plugins/attachments/downLane.ts`). Leaving that phase out also means an abort has nothing in Storage to clean up.

**One classification rule.** Write it once, as a helper next to `deriveContentKey` in `src/sync/crypto/contentKey.ts`, and use it from every pass. For an object with bytes `b` and name `n`:
- it is **raw** iff `n == hex(sha256(b))`, the content-addressed shape every plaintext-mode upload has;
- its **keyed** name is `hex(HMAC(K_id, sha256(b)))`.

The rule reads the content, never a header and never the name's shape: raw and keyed names are both 64 hex characters.

**One verification helper.** A stored object counts as good only if it's fetched, decoded and hash-checked. That logic exists three times today:
- `src/plugins/attachments/resolver.ts`;
- the occupied-path branch of `src/plugins/attachments/uploadDrain.ts`;
- `src/plugins/attachments/uploadRecovery.ts`.

Extract it once as `verifyStoredObject → match | mismatch | undecodable`. The cleanup uses it after every upload, and for a 409 on an occupied path.

**The cleanup**, repeated until a complete listing needs no action:
1. **List completely before acting**, through `list_workspace_objects`. It's a keyset scan of `storage.objects` (`name > after_name`, ordered by name), so a delete anywhere can never shift a later object out of the scan. It returns nested names (`<ws>/sub/file`) as real objects, not as virtual folder entries. And it runs in the owner's session, through an owner-only RPC.
   - The audit's lister (`AuditIO.listObjects` in `src/plugins/attachments/audit/supabaseAuditIO.ts`) doesn't fit, for three reasons. It is a server-only adapter on a secret-tier key that bypasses RLS across every workspace, so it must never reach a browser. It pages by offset. And it returns folders as virtual entries.
2. **Build K, after the listing completes**: the keyed path of every media block in the workspace, plus every recorded path. Reading it afterwards is load-bearing (see below). A recorded path whose object is absent is re-uploaded from its source; one that's present but unverified gets verified.
3. **Handle every listed object outside K:**
   - **Raw:** record the keyed path, seal, upload, verify, mark it verified, and only then delete the raw object. A crash leaves the raw source plus the record, and resume finishes the job. This also covers a raw object no block names yet, such as a capture whose block is still parked behind the freeze. When that block arrives, its keyed bytes are already there.
   - **The keyed name of a listed raw object: keep it.** It's that raw object's conversion destination, which another cleaner may be recording and verifying right now.
   - **Anything else: delete it by its full path.** That includes a nested object, which can never be raw, because content-addressed uploads are flat.
     - It isn't ours, because every cleanup upload is recorded before it starts.
     - No media block names it, so nothing the app shows depends on it.
     - It can't be assumed harmless, because any writer can put any bytes under any name.
     - Each deletion is listed in the report.

**The proof:** in the final complete listing,
- no raw object remains;
- nothing lies outside K;
- every K path is present, except where no source exists anywhere.

That last case means no raw object and no local bytes on this device. It's computed at proof time rather than stored, and reported to the user before `finish`.

**Concurrent cleaners are safe, with no lease.**
- **The deletes.**
  - A cleaner only deletes a raw object after its keyed copy is verified. Otherwise it deletes an object that is unrecorded, unnamed, and not the destination of any listed raw object.
  - The order rules out the race where one cleaner deletes a destination as unexplained while another is converting its raw source into it. A cleaner records a destination before uploading to it and before deleting the source, and K is read only after the listing. So for any raw object R with destination P:
    - **R is still in the listing:** P is spared as R's destination.
    - **R had already gone before the scan reached it:** its cleaner had recorded P before deleting R, so P is in the K read afterwards.
  - Either way, P never reaches the delete branch.
- **The listing.** It's a keyset scan, so nobody's delete can hide an object from it. Raw objects only ever disappear during `cleanup_pending`: the fence refuses new ones ([§5.2](#52-the-freeze)). So a complete scan that finds no raw object proves none is left, however many cleaners ran and whatever any of them still has in flight.

**Media block ids don't change.** The app derives an attachment's Storage path from the block's `media:hash`, the workspace mode and `K_id`; it doesn't store the path. So after the conversion an existing media block reads the keyed path. Re-capturing a file that predates the conversion mints a second block, at the keyed id; that's accepted (§6).

**The drain derives its upload path at upload time** (#1293).
- It uses `rec.contentHash`, the live mode and `K_id`, never `rec.contentKey`.
- `rec.contentKey` stays as the OPFS key the bytes sit under.
- So records of any status (`staged`, `pending`, `failed`), a capture racing the pin upgrade, and an upload the fence refused all go to the right path with **no re-keying** of records or the byte store.
- Local entries under raw keys stay valid as the drain's source. The resolver's cache lookup by the keyed key misses once and re-downloads.

**The existing ciphertext audit** (`src/plugins/attachments/audit/`) checks only the `encb:v1:` magic and a minimum length. It's a detector, not the proof. The 6-hourly workflow will flag the workspace between the apply and the cleanup; that's expected.

### 5.6 Clients

Today `getMaterializability` returns `copy` for any workspace pinned plaintext, whatever the server says (`src/sync/keys/resolver.ts`). After a conversion, such a device would write `enc:v1:` strings into `blocks` and upload plaintext edits.

#1293 changes that for the case where the synced `workspaces` row says `e2ee` but the pin says `plaintext`:

| | Today | After |
|---|---|---|
| Materialize | `copy` | `defer`: rows stay staged and the local `blocks` keep their plaintext |
| Block upload | unsealed | **held**, and parked (below) |
| Attachment drain | uploads in plaintext mode | `defer`. The drain already leaves records pending on `defer`. |
| UI | — | unlock prompt (`src/components/workspace/WorkspaceKeyGate.tsx`) |
| Upload metadata | — | every upload declares `kmMode` ([§5.2](#52-the-freeze)) |

**Parking (#1301).** PowerSync uploads a device's transactions in strict order, and `complete()` is a prefix checkpoint. So one held or `PT429`-refused transaction would stall every later one, in every workspace, for as long as the device stays locked: possibly forever.

Instead, held and frozen transactions are parked per workspace in a local side table, in order, and replayed once a live check shows the workspace is writable from this device. Once a workspace has a parked transaction, its later ones park too. Reordering across workspaces is safe, because a transaction never spans workspaces.

This also closes the window where a retry lands after `finish` but before the device has learned the new mode. Replay consults the live mode, so it waits for the upgrade instead of being refused.

**The attachment live check.** Before every upload, the drain calls `workspace_upload_mode`. It defers on `frozen`, and in plaintext mode on `e2ee` too. The fence ([§5.2](#52-the-freeze)) is the guarantee. The check exists because a refused PUT lands in `failed`, which nothing re-drives until the user asks (`runUploadRecovery` in `src/plugins/attachments/assetUpload.ts`).

**Upgrading the pin.** This is a separate path from unlock, because `unlockWorkspaceWithKey` pins first and throws on a plaintext pin (`src/sync/keys/flows/unlockWorkspaceWithKey.ts`). Factor its canary validation and key-store write out, so the upgrade can supply its own pin step:
1. Validate the key against the server canary, and store it in the durable key store if it isn't there already.
2. Write a durable upgrade-pending marker for (user, workspace), next to the pin in localStorage.
3. `upgradeModePinToE2ee`.
4. `repo.drainSyncWorkspace(ws)`, the same drain `WorkspaceKeyGate` runs on unlock (`src/App.tsx`). It uses scope `'all'`, so it doesn't trust `needs_apply` flags. Updating `needs_apply` alone wouldn't enqueue observer work, because `blocks_synced_changes_insert` fires only on INSERT. Then run `runUploadRecovery` for any fence-refused uploads, and clear the marker.

**At startup, a present marker resumes the transition, branching on the pin.**
- If the pin is still plaintext, it re-runs step 3 first. The key is already stored, and it re-validates against the canary.
- It then runs step 4.
- It clears the marker only once the pin reads e2ee **and** the drain has completed. Clearing it earlier would drop the only automatic recovery signal while the device still defers.

A crash before step 2 leaves no marker and a plaintext pin, so the device keeps deferring and the next upgrade starts over.

**A device that copied ciphertext.** An older build that ran across the conversion may already have copied ciphertext into `blocks`, which shows up as envelope-shaped local content. Such a device is **not repaired in place**: rewriting every row would flood `row_events`. It needs the gated reset of [§7](#7-runbook) instead. The fleet prerequisite makes this a runbook-violation path, not a normal one.

**Local history (#1299).** The `blocks_row_event_update` trigger (`src/data/internals/clientSchema.ts`) has no WHEN clause, so every sync-applied update appends full OLD and NEW snapshots to the never-pruned `row_events`. The conversion's version bump would write that for every row on every device.

#1299 skips updates that change nothing but the row version. It compares the logged projection (`blockJsonObjectSql`) minus `updatedAt`, with `userUpdatedAt`'s `coalesce` fallback to `updated_at` neutralized, so columns added later are covered automatically.

**Known gap: a block edit made during the window.** If a parked edit still reaches the server under the wrong mode, the ciphertext trigger quarantines it, and it stays on its device in `ps_crud_rejected`. That can happen, for example, on a device that doesn't have #1301 yet. **Retry** in the System Status rejection dialog re-queues it after the upgrade, and the upload path seals it. Making that refusal transient instead would let a buggy client jam its queue forever, so that's declined.

### 5.7 Key custody

The workspace key is the one thing whose loss can't be repaired, so the flow (#1290) treats every key write as hazardous.

- **Mint with proof.** Extract `mintWorkspaceKey(workspaceId)` from `src/sync/keys/flows/createEncryptedWorkspace.ts`, so the conversion can't drop a step. It runs:
  1. generate, import and derive `K_id`;
  2. mint the canary;
  3. re-parse the **displayed** string and open the canary with it, as a round-trip self-check;
  4. probe a durable key-store write.

  Refuse when `canPersistPins()` fails, or when `createWorkspaceKeyStore` returned the in-memory fallback (`src/sync/keys/keyStore.ts`). A reload would otherwise lose the key.
- **One flow per profile.** Hold a `navigator.locks` lock for (user, workspace) from the preflight through `finish` or `abort`. The IndexedDB key store is shared across tabs, and `keyStore.put` replaces a record outright.
- **A "leftover" record is never deleted.** A key record counts as left over from a crash before `begin` only when a **fresh server read** says mode `none` and no attempt exists. Even then it's moved aside, not deleted.
  - A stale local view would otherwise delete the real key of a conversion that has already finished.
  - The stored key is non-extractable, so a leftover can't be shown again either. A fresh key gets a fresh reveal.
- **`begin` refuses unless the mode is `none`**, checked inside its own transaction ([§5.1](#51-the-attempt)).
- **Before apply,** re-read the durable record (not the in-memory handle) and require it to open the attempt's stored canary.
- **Pin retirement, for key-loss recovery only** (#1302).
  - Offered only when this device holds an `e2ee` pin for a workspace whose server row is plaintext.
  - Requires an explicit confirmation that names the workspace and says it was deleted and restored after a lost key. It then drops the pin and the stale key record.
  - A hostile server can produce exactly that state, and refusing it silently is the pin's whole job. So retirement is per device, user-initiated, and never automatic.
- **Takeover** means another device carrying on an attempt with a pasted key. It stores that key **without pinning**. The pin changes only through `upgradeModePinToE2ee`, after the apply. Unlocking through `unlockWorkspaceWithKey` would pin e2ee first: an unpinned device that then saw the attempt aborted would stay e2ee-pinned on a plaintext workspace, uploading sealed edits that every other device reads as `enc:v1:` text.

### 5.8 Flow, resume, failure paths

The orchestrator (#1290) refuses to start unless all of these hold:
- the user owns the workspace;
- it's plaintext with no live attempt (otherwise it resumes the attempt);
- the key-custody checks of [§5.7](#57-key-custody) pass;
- the user confirms the named residue, such as a workspace already past `cell` ([§6](#6-what-stays-visible-afterwards));
- the local upload queue is drained, attachment records included;
- no rejected rows are pending;
- **zero sync divergence** for the workspace once a post-freeze checkpoint has synced. That means no `unapplied` or `stranded` rows, computed as `agent health` reports `syncDivergence` (`src/plugins/agent-runtime/healthCommand.ts`).
  - A stale or missing local row would otherwise leave the snapshot short, and make the local plaintext a wrong source for repair.
  - The remedy is `repo.drainSyncWorkspace` followed by a re-check. A checkpoint wait alone doesn't clear a durable gap. If divergence remains, the conversion refuses;
- the converting device sets `repo.setReadOnly(true)` for the run, so no block edit there changes the plaintext being converted;
- the prerequisites of [§7](#7-runbook) hold.

| Step | If it fails | State left | Recovery |
|---|---|---|---|
| **Key**: `mintWorkspaceKey`, reveal once, require a retype, store durably | before anything else | nothing | retry |
| **Begin** | refused: an attempt exists | another device or tab is converting | resume it with its key, or abort it explicitly while `staging` |
| **Archive**: export, then read back ([§5.4](#54-history-archive-verify-purge)) | export or read-back fails | frozen | redo the archive, or abort |
| **Settle, snapshot and stage**: wait for a post-freeze checkpoint; require zero sync divergence for the workspace (below); **re-scan the residue and re-confirm it** with the user (a properties switch or synthesized definitions that landed just before `begin`); take the content-recovery snapshot ([§7](#7-runbook)); then seal → verify → stage page by page, keeping the per-row verification record | crash, base mismatch, or divergence that the drain doesn't clear | frozen, partly staged | resume (re-staging is idempotent per block); a mismatch means a pre-freeze read; refuse to continue while divergence remains |
| **Apply** | refusal or timeout | rolled back; `staging` | fix and re-apply, or abort |
| **Verify** ([§5.3](#53-sealing-apply-verification)) | rows fail to open or don't match | `applied`; history and local plaintext intact | re-stage those rows and re-apply |
| **Purge**, with the read-back count | count mismatch | `applied` | redo the archive |
| **Upgrade the pin** ([§5.6](#56-clients)) | crash | marker set, or pin still plaintext | automatic at startup |
| **Attachment cleanup** ([§5.5](#55-attachments)) | partial | `cleanup_pending` | resume; it rebuilds K from blocks plus the recorded paths |
| **Proof** ([§5.5](#55-attachments)) | a check fails | `cleanup_pending` | investigate; nothing is lost while the key is held |
| **Finish** | RPC error | `cleanup_pending` | retry |

**Resume.** On load, an owner device reads `get_workspace_conversion` for each workspace it owns. Abort and abandon are never automatic.
- **`staging`:** if this device's durable key opens the stored canary, continue, redoing the archive unless its own verifies. Without that key, show "a conversion is in progress" with two choices: paste its key to take over, or abort explicitly.
- **`applied` or `cleanup_pending`:** with the key, continue from that state. A takeover in `applied` verifies from the staged `verify_record`s ([§5.3](#53-sealing-apply-verification)). Without the key, prompt for it. Abandon is offered only when the user confirms the key is lost, and leads into the recovery procedure ([§7](#7-runbook)).

## 6. What stays visible afterwards

Metadata that stays visible:

- From the e2ee design's §15: tree shape, ordering, edit timing, authorship, `deleted` flags, and which column changed.
- Added by this conversion:
  - ciphertext lengths;
  - the original timestamps, which this conversion deliberately keeps;
  - `workspaces.name`, which the runbook renames first if it's sensitive.

**Derived ids stay as they are, and some remain guess oracles.** Anyone who knows or can enumerate a key can hash it under the public namespace and look for the row.

| Kind | Key | Who can test it |
|---|---|---|
| Alias seats (`src/data/targets.ts`) | page name, as minted (a seat keeps it across renames) | anyone who guesses a name. Open for every e2ee workspace (#719) |
| Media blocks (`src/plugins/attachments/mediaCapture.ts`) | sha256 of the file | anyone holding the file |
| Daily notes (`src/plugins/daily-notes/dailyNotes.ts`) | ISO date | anyone (enumerable): which days have a note |
| Roam import (`src/plugins/roam-import/blockIds.ts`) | Roam uid | holders of the source graph |
| Extension records (`pluginBlockId` and derived identities) | whatever the extension chose: external ids such as Readwise `user_book_id` and highlight ids (`agent-extensions/readwise.tsx`) or Matrix event ids (`agent-extensions/matrix-chat-client.tsx`); user-chosen keys such as Strength Tracker dates and group keys (`agent-extensions/strength-tracker/src/km/store.ts`) | the external service, or anyone who knows the value |
| Synthesized property definitions, **only if** the workspace switched to properties-as-blocks before the conversion (forward-only) | the property name, under plaintext synthesis's public namespace (`src/data/internals/propertyDefinitionSynthesis.ts`) | anyone who guesses a property name. Switching after the conversion mints K_id-keyed ids instead. |
| Kernel pages, definition seeds, the user page, state children | code-owned constants and ids | anyone. They reveal which features are used, not what the user wrote. |

**Why the conversion doesn't re-id them.** Each one would mean delete + insert + rewriting every pointer, which turns a pure re-seal into a migration with its own failure modes:

- **A peer that hasn't unlocked loses blocks.** The observer hard-deletes a removed id once its staging row is gone, even though it has deferred the replacement (`src/data/internals/syncObserver/materialize.ts`).
- **Old links and other devices' `row_events` break,** unless a durable old→new lookup exists.
- **The residue can't be counted.** A seat whose original name appears in no history looks like any other uuidv5.
- **Extension keys need their owners to judge them.**

All of that applies equally to existing e2ee workspaces. So it belongs to one re-id migration for all of them (#1297), which waits on #719's namespace fix. The production run waits on #719 itself, so that new `[[links]]` stop minting public ids.

## 7. Runbook

The first production run is #1288.

**Prerequisites.** This list is the single owner of the order.

1. **Deploys, in this order:**
   1. Builds with #1293, #1299, #1301 and #1300 reach **every** device. #1293 brings the `kmMode` declaration and the drain-time upload path; #1300 makes a read-only database transient for the upload classifier.
   2. Only then #1294's Storage policy. Shipping it earlier would start refusing old builds' uploads to existing e2ee workspaces.
   3. #719.
2. **No wipe shortcut.** A device that can't run the required build stays offline until it can.
   - Clearing site data is not a substitute. It erases every workspace key, pin, `row_events` history, extension approval and pending attachment on that browser profile, for every account.
   - If a device must be reset anyway (for example after copying ciphertext, [§5.6](#56-clients)), gate it: drain every workspace's queue; confirm no pending or failed attachment records; confirm every e2ee key on that profile is saved elsewhere; take a raw SQLite export first.
3. **Fleet.** Every device's upload queue is drained, and editing pauses on other devices for the whole run.
4. **Key custody.** Plan two independent places for the key, such as a password manager and paper. The history archive goes with them.
5. **Workspace name.** Rename it first if it's sensitive, and let the rename sync. The old name lingers in dead tuples until step 13, and in backups ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).
6. **Disk headroom.** Measure the workspace's content-column bytes with `select sum(octet_length(content) + octet_length(properties_json) + octet_length(references_json)) from blocks where workspace_id = …`. Confirm free disk of at least about 6× that, which covers the apply's roughly 5.5× peak plus slot-retained WAL ([§5.3](#53-sealing-apply-verification)). Also confirm room for `VACUUM FULL` to write a full copy of each table it rewrites. Auto-scaling disk only grows on a cooldown.
7. **Ordering.** Leave the workspace on the `cell` properties model until afterwards. Synthesis runs only in the properties-as-blocks switch (`src/plugins/properties-migration/action.ts`), and on an e2ee workspace it mints K_id-keyed ids (`resolveSynthesisNamespace`).
8. **Rehearse** on a scratch workspace first: convert it, then run the key-loss recovery below end to end.
9. Run the flow from a desktop with the most attachment bytes stored locally.

**Content-recovery snapshot.** The flow prompts for it once the workspace is frozen, this device has synced a post-freeze checkpoint, and the workspace shows zero sync divergence ([§5.8](#58-flow-resume-failure-paths)). At that point it holds exactly what the apply will convert.
- It is a zip of a raw SQLite export (`src/utils/exportSqliteDb.ts`, which covers the `.db` files only) plus every attachment's plaintext bytes. The bytes come from the local byte store, or are downloaded from Storage, which still holds them raw at that point.
- The flow reads the zip back to check it.
- Keep it encrypted and offline. It is plaintext.
- **It is not a rollback.** The only rollback is `abort`, and only while `staging`. After the apply, e2ee → none is refused by design.

**After:**

10. The proof passes and `finish` succeeds.
11. Other devices paste the key and upgrade.
12. **Operator: drop leftover ad-hoc tables** from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`) if they still exist. They hold ids and timestamps.
13. **Operator: `VACUUM FULL`** on `blocks`, `blocks_history`, `storage.objects` and `workspaces`, whose dead tuples hold plaintext or the old sha256 paths and name.
    - It takes ACCESS EXCLUSIVE locks, blocking **reads and writes** on each table for a time proportional to that table's **total** size across all workspaces. Schedule it.
    - `pg_repack`, if available, is the non-blocking alternative.
    - The staging tables hold only ciphertext, so they don't need it.
14. **Act on #1289's findings**: PowerSync compaction or reprocess, and purging versioned Storage objects. Then record the "safe from" date ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).

**Key-loss recovery.** Lose the key and the server copy is unrecoverable. The content survives only in the snapshot and on devices that still defer: those keep their pre-conversion plaintext `blocks`, until a removal reaches them.
1. **Export first.** On every deferring device, take a raw SQLite export before anything else.
2. **Abandon** the attempt, if one is live, so the workspace unfreezes and stops stalling uploads.
3. **Delete the dead workspace.** This hard-deletes on every deferring device too, which is why step 1 comes first. The operator then deletes its remaining `blocks_history` rows and its Storage prefix.
4. **Restore under the same workspace id** (#1302). Create a plaintext workspace with the dead workspace's id (`create_workspace` takes `p_workspace_id`), then import the snapshot with the same block ids. Both are possible only after step 3, because ids are a global primary key.
   - A new workspace id would make every workspace-derived deterministic id disagree with what the runtime derives: daily notes, alias seats, kernel and user pages, media and plugin ids. The app would then mint duplicates.
   - The import is lossless only once #401 carries properties and timestamps.
5. **Retire the pin on each device**, as a deliberate user gesture (#1302, [§5.7](#57-key-custody)). Every upgraded device holds an `e2ee` pin for that id, which refuses the restored plaintext workspace. That refusal is exactly the downgrade protection, so it is lifted only by an explicit per-device confirmation, never automatically.

## 8. Platform residue, and when it is "safe if breached"

These copies are outside the repo's reach, so none of them is verified here. #1289 confirms each one, with its source:

- **Supabase daily backups, PITR and WAL archives** hold plaintext until they age out. Early deletion is probably impossible.
- **Postgres error logs.** A constraint failure can print "Failing row contains (…)".
- **Storage.** Whether deleted objects are versioned or soft-deleted at the storage layer.
- **PowerSync Cloud bucket storage.** It likely keeps superseded operations with full row data until compaction. Open questions: can compaction be forced, and does deploying changed sync rules reprocess from scratch?
  - **A premise to confirm:** neither compaction nor a reprocess may ever yield a checkpoint missing a row. A missing row would hard-delete on every device that defers, destroying the key-loss fallback.

The honest claim has two parts:

- **Live systems.** After the conversion, the cleanup and the vacuum, the live database is clean. So is live Storage, unless #1289 finds versioning. The sync service is clean only after #1289's prescribed clean-up. From then on, a breach of the live systems exposes only ciphertext and the metadata in [§6](#6-what-stays-visible-afterwards).
- **Backups.** A breach of a backup is safe only once the longest retention window above has passed since that clean-up. The runbook records that date.

## 9. What the workspace gives up

- **Server-side anomaly detection.** The L5 detectors in `scripts/supabase-health.mjs` are plaintext-only.
- **Server-history procedures.** These read `blocks_history`, such as the dangling-reference classification in `scripts/dangling-refs/README.md`.
- **The consistency check**, until it is fixed (#233).
- **Any future server-side feature**: search, AI, and server-rendered or anonymous share links (`docs/e2ee-design.html` §10/§15).
- **Recovery without the key.** Losing the key loses the server copy.
- **Bandwidth, once.** Every device re-downloads the whole workspace.

## 10. Relation to workspace-key rotation

Rotation (`docs/e2ee-design.html` §14, unbuilt) reuses most of this machinery:

- the attempt;
- the freeze;
- sealing, with a stage base over the wire value (which already handles an old-key ciphertext source);
- verify-before-purge;
- the attachment cleanup.

It also needs the #1297 re-id migration, because the K_id-derived ids change with K_id: synthesized definitions, keyed media ids, and alias seats once #719 lands.

Rotation differs from this conversion in two places:

- **A new admitted transition:** `e2ee → e2ee` with a new canary, plus a decrypt step.
- **A different source-object rule in the attachment cleanup:**
  - an old-key object's name is `hex(HMAC(K_old, h))`, which can only be recognized when `h` is known from a media block;
  - every other object outside the new K is deleted, exactly as this conversion deletes unexplained objects, so an old-key orphan with an unknown hash can't survive to be read with the retired key.

## 11. Alternatives considered

- **Export → new e2ee workspace → import.** Rejected ([§2](#2-decision-convert-in-place-not-by-copy)). It would leave an untouched fallback workspace, which in-place lacks. The trade is accepted for the ids and history that in-place keeps.
- **Re-iding user-text-derived ids during the conversion.** Deferred to #1297 ([§6](#6-what-stays-visible-afterwards)).
- **Gradual re-upload through the normal patch path, with no freeze.** Rejected.
  - The ciphertext trigger checks the whole new row, so once the mode flips, an edit to a not-yet-resealed row is refused.
  - Without the flip, plaintext-pinned peers keep uploading plaintext.
- **Purging history inside the apply.** Rejected, because it would destroy both plaintext copies before anything verified the result ([§5.3](#53-sealing-apply-verification)).
- **Writing the apply's own history and deleting it in the same transaction.** Rejected. It strands a full plaintext-plus-ciphertext copy until a vacuum, and the attempt-scoped setting suppresses it narrowly instead.
- **Persisting the stage bases and re-checking them at apply.** Rejected. The freeze already guarantees nothing changes in between, and stored unkeyed hashes would outlive the plaintext.
- **A pre-apply attachment upload phase.** Rejected ([§5.5](#55-attachments)). The cleanup converts every raw object anyway, and the phase would force an abort to clean up Storage.
- **A cleanup lease.** Rejected.
  - It was only ever needed for the listing, and an offset-paged lister isn't stable under another cleaner's deletes.
  - Listing through a keyset scan of `storage.objects` makes it stable, so nothing depends on mutual exclusion ([§5.5](#55-attachments)).
  - A lease would also need its own fence for in-flight Storage deletes from a holder whose lease had lapsed.
- **Reusing the audit's Storage lister for the cleanup.** Rejected: it's server-only, on a secret-tier key that bypasses RLS, and it's offset-paged and folder-virtual ([§5.5](#55-attachments)).
- **Reporting unexplained attachment objects instead of deleting them.** Rejected. Any writer can store any bytes under any name, so "not content-addressed" proves nothing about plaintext.
- **Re-keying upload records and the byte store at the pin upgrade.** Rejected. Deriving the upload path at drain time removes every case it had to cover ([§5.5](#55-attachments)).
- **Repairing a device that copied ciphertext in place.** Rejected, because it would flood `row_events`. Use the gated reset instead.
- **Wiping devices instead of upgrading them.** Rejected ([§7](#7-runbook)).

## 12. Tracking

| Piece | Issue | Waits on |
|---|---|---|
| Epic | #1295 | — |
| Server: attempt, freeze, apply, purge, the mode admit | #1294 | #1293 deployed everywhere (for its Storage policy only) |
| Clients: defer, hold, live check, `kmMode`, drain-time path, pin upgrade | #1293 | — |
| `row_events`: skip version-only updates | #1299 | — |
| Park a workspace's held or frozen uploads | #1301 | — |
| Upload classifier: 25006 is transient | #1300 | — |
| Sealing pages | #1292 | — |
| Attachment cleanup | #1291 | — |
| Orchestrating flow, key custody, archive and its decoder | #1290 | #1291, #1292, #1293, #1294 |
| Platform retention spike | #1289 | — |
| First production run | #1288 | #719, #1289, #1290, #1293, #1299, #1300, #1301, #1302 |
| Key-loss restore under the same id, with user-confirmed pin retirement | #1302 | — |
| Re-id migration for user-text-derived ids, every e2ee workspace | #1297 | #719 |
