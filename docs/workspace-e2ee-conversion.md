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

The server side (#1294) is owner-only SECURITY DEFINER RPCs over a staging area in the `private` schema, which PostgREST doesn't expose.

**One conversion attempt is the unit of everything.** The server row is that attempt's durable state. Every client step is idempotent and keyed by the attempt, so a crash anywhere resumes from what the server says rather than from what the crashed tab remembered.

- `private.workspace_conversions(workspace_id pk, attempt_id, canary, state, started_by, started_at, lease_holder, lease_until)`.
  - `state` is `staging`, `aborting` or `cleanup_pending`. **The workspace is frozen for as long as an attempt row exists**, from `begin` until `finish`, or until an abort completes.
  - `canary` is the new key's canary. The client mints it before `begin` and it's stored here, so the attempt is bound to exactly one workspace key.
  - The lease columns allow one worker per attempt for everything that writes or deletes attachment objects: the pre-apply uploads, the cleanup and an abort ([§5.4](#54-attachments)).
- `private.workspace_conversion_rows(workspace_id, attempt_id, block_id, content, properties_json, references_json)` holds only the sealed columns. The conversion only updates rows, so staging needs no op column, inserts or deletes.
- `private.workspace_conversion_objects(workspace_id, attempt_id, keyed_path, status)` records **every attachment object the conversion writes, before it writes it** ([§5.4](#54-attachments)):
  - `intended`: recorded, upload not yet verified;
  - `verified`;
  - `missing`: a media block whose bytes no source still holds.

  Recording before uploading means a crash can never leave an object of ours that nothing records. It also means an abort can find every object to delete without the key, and a resume gets back the paths of converted orphans that no server block names.

  The names are keyed HMACs, so storing them adds no fingerprint.

**Every id is scoped to the workspace being converted.** These functions run with the definer's privileges and bypass RLS.

- A staged `block_id` whose server row is in another workspace, or doesn't exist, is refused at stage time.
- The apply's UPDATE is restricted to `workspace_id = ws`.

Without both, a caller who owns workspace A could overwrite a block in workspace B by guessing its id.

**Every attempt RPC locks the attempt row first.** Each RPC except `begin` starts with `SELECT … FOR UPDATE` on the live attempt row for `ws`. It refuses if the row is missing, belongs to another `attempt_id`, or isn't in the state the RPC requires. Every state change it makes must affect exactly one row, or it raises.

Without this, two owner tabs could interleave. An `abort` could delete the attempt while an `apply` was mid-transaction, leaving an e2ee workspace with no `cleanup_pending` marker and no freeze.

**The freeze is enforced at both write surfaces.**

- **Block writes** stall instead of being quarantined.
  - A BEFORE trigger on `blocks` refuses every write to a frozen workspace, except the apply's own, raising **`PT429`**.
  - PostgREST turns that into HTTP 429, which `classifyUploadError` retries forever (`src/services/uploadErrorClassifier.ts`). That's the trick `blocks_refuse_anon` plays with `PT401` (`20261013120000_refuse_anon_writes_to_blocks.sql`). A 22/23/42/P0002 code would quarantine the edits instead.
  - **"The apply's own" is narrow.** It means `current_user = 'postgres'` **and** a transaction-local `km.conversion_attempt` equal to the live `attempt_id`, which only `apply` sets (`set_config(…, true)`).
    - `current_user` alone would admit every SECURITY DEFINER function. `delete_workspace`, for one, runs as `postgres` (consolidated initial migration), and its cascade would write full-row plaintext DELETE entries into history mid-conversion.
    - PostgREST clients can neither be `postgres` nor call `set_config`, so the pair can't be forged.
  - `delete_workspace` also refuses outright while an attempt exists ("finish or abort the conversion first"), so the owner gets a clear error rather than a stalled cascade.
- **Attachment inserts.** A plaintext-mode insert is refused when it lands.
  - Each upload declares the mode it was encoded under in its Storage metadata: `kmMode`, which storage-js sends as `x-metadata` and stores as `user_metadata`.
  - The `attachments` INSERT policy (`20260625000000_add_attachments_storage.sql`) calls `private.attachment_insert_admitted(ws, kmMode)`. That function refuses `kmMode = 'none'` under a workspace that is frozen or e2ee.
  - The conversion's own keyed uploads declare `e2ee`. Under a frozen or e2ee workspace, **anything that doesn't declare `e2ee` is refused**, and a missing field counts as plaintext.
    - That fails closed for any build that predates the declaration: a device the fleet preflight missed, or a member who accepts an invitation mid-conversion on a cached build (`accept_invitation` just inserts a membership row).
    - Membership therefore needs no freeze of its own. Both write surfaces fail closed for whoever is a member.
    - **Deploy order:** ship the declaring client to every device first, then the policy. Otherwise old-build uploads to an *existing* e2ee workspace start being refused.
- **Attachment uploads also defer on the client.** A build with #1293 checks `workspace_upload_mode` before every upload and defers while frozen ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)). The insert-time check is the guarantee; this check spares most uploads a refusal.

**`begin` is serialized against writes already in flight, on both surfaces.** A write whose check read a snapshot from before the attempt row existed could otherwise commit after `begin`, behind a stage check or a cleanup listing that had already run.

- **Blocks.** `begin` takes `LOCK TABLE public.blocks IN SHARE MODE` (with a `lock_timeout`, retried) before inserting the attempt row. SHARE conflicts with the ROW EXCLUSIVE lock every writer holds, so `begin` waits for in-flight block writes to finish, and new ones wait for `begin`. When they resume, their trigger reads the freeze in a fresh read-committed snapshot and refuses.
- **Storage.**
  - `private.attachment_insert_admitted` first takes `pg_advisory_xact_lock_shared(<ws key>)`, and `begin` takes the exclusive `pg_advisory_xact_lock(<ws key>)`. An insert holds the shared lock until its transaction ends.
  - So `begin` waits for every in-flight attachment insert under `ws`, and a later insert waits for `begin` and then sees the attempt row.
  - The lock is per workspace and costs one advisory lock per attachment insert, which are rare. It isn't a table lock on `storage.objects`, which would pause uploads to every workspace.

After `begin` commits, only the apply writes the workspace's blocks, and only keyed (`e2ee`) uploads land under it.

The cost is a fleet-wide block-write pause for the length of `begin`'s transaction, once per conversion. Two alternatives were rejected: a per-write advisory lock on `blocks` costs every write forever, and keeping the bases until apply would keep plaintext fingerprints.

**Premises to verify first (#1294).** All three concern Storage internals the repo can't show:

1. Storage evaluates the INSERT policy with the request's `user_metadata` populated.
2. A policy may call a SECURITY DEFINER function that takes an advisory transaction lock.
3. That insert's transaction stays open until the object row commits.

If any of them fails, the fallback is a separate bucket for e2ee-mode objects. The bucket itself then acts as the declaration, and `begin` serializes on the plaintext bucket instead. That's heavier, because the existing e2ee workspace's objects have to move.

1. **`begin_workspace_conversion(ws, canary) → attempt_id`** takes both serialization locks, refuses if any attempt row exists for `ws` (one attempt at a time), and inserts the attempt in `staging`, which freezes the workspace.
2. **`stage_workspace_conversion(ws, attempt_id, rows)`** is chunked.
   - Each row carries the sealed columns plus a **base**: `sha256` of each column's **wire value** as the client read it from `blocks_synced`. For this conversion that's the plaintext. Under rotation it would be the old-key ciphertext, so the same RPC serves both ([§10](#10-relation-to-workspace-key-rotation)).
   - It compares each base with `sha256(convert_to(col, 'UTF8'))` of the current server row and refuses the chunk on any mismatch. All three columns are `text` on the server, so the bytes are the ones the client hashed.
   - **The base is checked, then discarded, never stored.** Here it's an unkeyed plaintext hash. Left in staging, or in its dead tuples, it would remain a dictionary-testable fingerprint after the plaintext is gone.
   - A stage-time check is enough because, after `begin`, nothing but the apply writes the workspace.
   - Re-staging a block within the same attempt replaces its earlier row.
3. **`apply_workspace_conversion(ws, attempt_id, history_archived_count)`** runs as ONE transaction, with a raised `statement_timeout` (as `delete_workspace` has, `20260513205724_extend_delete_workspace_timeout.sql`):
   1. Lock the attempt and check it's still `staging`. Set `km.conversion_attempt` for this transaction.
   2. **Check the history archive is complete.** `count(*)` of `blocks_history` for `ws` must equal `history_archived_count` ([§5.5](#55-history-archive-then-purge)). The freeze keeps that count stable, so a short archive refuses the purge instead of losing rows for good.
   3. Check completeness: the staged ids are exactly the workspace's block ids, **soft-deleted rows included**.
   4. Set `encryption_mode = 'e2ee'` and `wk_canary` from the **attempt's stored canary** (never a parameter) **first**, so `blocks_require_ciphertext_for_e2ee` validates every row the next step writes.
   5. Update the three sealed columns from staging, `WHERE workspace_id = ws`, and check that the row count equals step 3's. **The history trigger skips these writes.** It sees the same attempt-scoped `km.conversion_attempt`, so the apply writes no transient history copy.
   6. `DELETE FROM blocks_history WHERE workspace_id = ws`, which purges the pre-existing plaintext history.
   7. Clear the staging rows and set `state = 'cleanup_pending'`. **The freeze stays**, because the attachment cleanup of [§5.4](#54-attachments) has to run while nothing but keyed uploads can land.

   The attempt row also stays, because it's the only durable record that plaintext Storage objects still need converting.
4. **`finish_workspace_conversion(ws, attempt_id)`** deletes the attempt row, which **ends the freeze**. The client calls it only after the cleanup and its proof ([§5.4](#54-attachments)) pass.
5. **Abort is two-phase, and works only from `staging`.**
   - `abort_workspace_conversion(ws, attempt_id)` moves the attempt to `aborting`. From then on `record_conversion_object` refuses, so no new conversion upload can start.
   - The aborting device takes the lease and deletes every recorded path. It needs no key, because the paths are stored. It then relists to confirm they are gone.
   - Only then does `finish_abort_workspace_conversion(ws, attempt_id)` clear the staging rows, the recorded objects and the attempt, which ends the freeze.
   - Blocks never changed. An upload already in flight on another device that lands after the deletes is a ciphertext orphan: harmless, and reported by any later cleanup.
   - There's no abort after the apply ([§7](#7-runbook) step 5).
6. **`claim_conversion_lease(ws, attempt_id, holder)`** grants or renews a time-limited lease, so one device at a time works the attempt's attachment objects. **`record_conversion_object(ws, attempt_id, holder, keyed_path, status)`** requires that lease and refuses while `aborting` ([§5.4](#54-attachments)).
7. **`get_workspace_conversion(ws)`** is the owner-only read that resume starts from. It returns `attempt_id`, `canary` and `state`.
8. **`workspace_upload_mode(ws)`** is readable by any member. It returns `frozen` while an attempt exists, otherwise `none` or `e2ee`.

**Suppressing the history trigger is now narrow, so the apply does it.** An earlier draft deleted the apply's own history rows inside the transaction rather than suppress the trigger. The concern was that the trigger is SECURITY DEFINER, so `current_user` can't identify the conversion. The attempt-scoped setting does identify it, and only the apply sets it.

Suppression also removes the largest transient allocation. Without it, every row's plaintext-before and ciphertext-after diff would be written and then deleted in the same transaction, and MVCC and WAL don't give that space back until a vacuum.

**Disk headroom.** Postgres can't see free disk from SQL, so the runbook checks it ([§7](#7-runbook) step 6). Even with suppression, the apply holds roughly 4× the content columns at its peak:

- the staging copy, about 1.33× the content columns;
- the new row versions, about 1.33× again;
- the WAL for both.

**The cost of the freeze.**

- It lasts from `begin` to `finish`: staging, the apply, and the attachment cleanup. For a large workspace that's minutes.
- A crash during it leaves the workspace frozen until an owner device holding the key resumes the attempt ([§5.6](#56-flow-and-failure-paths)).
- That cost is accepted. The freeze is what makes the archive, the stage check and the cleanup sound.

**What happens to timestamps.** The re-seal changes every row's content columns, so the clamp trigger raises `updated_at` to at least `OLD.updated_at + 1` on every row (`20260803000000_add_patch_base_version_drift_bump.sql`). That's intended:

- `updated_at` is the row version, and the bump is how peers know to re-download.
- What the user sees is `user_updated_at`, which display reads instead of `updated_at`. The apply leaves it untouched, along with `created_at`, `created_by` and `updated_by`.
- **The bump must not become local history.** The local `blocks_row_event_update` trigger (`src/data/internals/clientSchema.ts`) has no WHEN clause, so every sync-applied update appends full OLD and NEW snapshots to the never-pruned `row_events`.
  - A whole-workspace bump would write hundreds of MB of redundant history on every device, right after an irreversible step.
  - #1299 makes the trigger skip updates that change nothing but the row version. It compares the projection it logs, minus `updatedAt`, so columns added later are covered automatically.
  - That's a general dedup (drift bumps benefit too), and it must reach every device before the first conversion.

### 5.2 Client: a plaintext-pinned device that sees e2ee

Today `getMaterializability` returns `copy` for any workspace pinned plaintext, whatever the server says (`src/sync/keys/resolver.ts`). After a conversion, such a device would:

- write `enc:v1:` strings into `blocks` and its FTS and alias indexes;
- upload plaintext edits, which the ciphertext trigger rejects permanently;
- upload attachments in plaintext mode. That one **is** a leak: unlike blocks, Storage has no server-side content check.

The change (#1293) applies when the synced `workspaces` row says `e2ee` but the pin says `plaintext`:

| | Today | After |
|---|---|---|
| Materialize | `copy` | `defer`: rows stay staged in `blocks_synced`, and the local `blocks` keep their plaintext |
| Block upload | unsealed | **held** for that workspace; nothing is sent |
| Attachment drain | uploads in plaintext mode | `defer`: the drain already leaves a record pending on `defer` materializability (`src/plugins/attachments/uploadDrain.ts`) |
| UI | — | unlock prompt (paste the workspace key) |

**The attachment drain also confirms the live mode.** The synced `workspaces` row can lag, because the mode change arrives in the same large checkpoint as every resealed block. So before **every** upload, the drain calls `workspace_upload_mode` ([§5.1](#51-server-freeze-stage-apply-abort)):

- it defers on `frozen`;
- when it is about to upload in plaintext mode, it also defers on `e2ee`.

- After the apply, the mode never goes back. So a fresh `e2ee` answer stays true.
- **The race a client-side check can't close.** A check answers `none` just before `begin`, then a PUT lands after. The insert-time check ([§5.1](#51-server-freeze-stage-apply-abort)) closes it: the PUT is refused, and the drain marks its record failed.
  - The pin upgrade then resets that workspace's failed upload records to pending. They're re-keyed, so they upload sealed.
  - A PUT that landed before `begin` committed is a plain pre-conversion object, and the cleanup converts it.
- The cost is one extra read per attachment upload, fleet-wide.
- Block uploads don't get this check. The ciphertext trigger already fails them closed (see the known gap below). Attachments have no such backstop, and the read is what stands in for one.

The conversion only updates rows, so it sends locked peers no deletes. A deferred peer therefore keeps every block it had, unchanged, until it unlocks.

**Upgrading the pin.** Once a key opens the server canary, the existing `unlockWorkspaceWithKey` checks run. Then `upgradeModePinToE2ee` runs, in this order, so that a crash between steps is harmless:

1. Mark every staged `blocks_synced` row of the workspace for re-apply. That repairs a device that ran an older build across the conversion and already copied ciphertext into `blocks`.
2. **Re-key the local byte store.** The byte store and every pending upload record are keyed by the content key computed at capture (`rec.contentKey`, a raw sha256 for a plaintext capture), and the drain reads the bytes by that key (`src/plugins/attachments/byteStore.ts`).
   - A raw key and a keyed key are both 64 hex characters, so an entry's **name** can't say which it is. Classify each entry by its **content** instead: the store holds plaintext, so `h = sha256(bytes)` is always the true content hash.
   - A key equal to `hex(h)` is raw. Handle it in this order:
     1. Copy the entry to `hex(HMAC(K_id, h))`.
     2. Point **every** upload record of the workspace that names the raw key at the copy, whatever its status: `staged`, `pending` or `failed` (`ByteUploadStatus` in `src/plugins/attachments/uploadStore.ts`). A `staged` record matters too, because the boot reconciler can still promote it later. A record's `contentKey` is both its Storage path and its OPFS key, and `requeue` changes only the status, so a failed record left on the raw key would miss its bytes on the next drain.
     3. Drop the raw entry.
   - A key equal to `hex(HMAC(K_id, h))` is already keyed: skip it. A retry therefore never re-keys a copy.
   - Anything else is corrupt: report it and leave it.
   - Then requeue the workspace's **failed** upload records, which by now point at keyed copies. They're plaintext-mode PUTs that the insert-time check refused ([§5.1](#51-server-freeze-stage-apply-abort)), and they now upload sealed.
   - Re-keying only the record would strand its bytes, and the drain would see a clean miss and fail the record.
   - Leaving it alone would upload ciphertext to a raw sha256 path.
   - Copy-then-switch plus content classification means a crash at any point leaves at worst a duplicate, and a retry finishes the job.
3. **Then** write the pin.

The pin lives in localStorage and the flags in SQLite, so nothing makes the steps atomic; the ordering is what makes them recoverable. If the device crashes before step 3, the pin is still plaintext and the server still says e2ee. So the device still defers, and the next upgrade simply redoes steps 1 and 2, which are idempotent. If it crashes after step 3, steps 1 and 2 are already done.

After the upgrade:

- A device whose key store already holds a key that opens the canary upgrades without asking. That covers the converting device, and one that crashed after the apply.
- The held block uploads drain, sealed, because `encryptUploadColumns` resolves the mode per op at upload time. A content-only patch is accepted at that point, since every server row already has all three columns sealed.

**The upload queue is FIFO.** PowerSync uploads a device's transactions in order, so holding one op stalls everything queued behind it on that device. The unlock prompt is what clears it.

This must reach every device **before** any conversion runs.

**Known gap: a block edit made during the window.**

- During the freeze, another device's plaintext edit gets `PT429` and retries.
- If that retry lands after `finish` ends the freeze, but before the device has learned the new mode, the ciphertext trigger refuses the edit with a permanent code. The edit is quarantined in `ps_crud_rejected`, still on that device.
- **Recovery:** after the device upgrades, **Retry** in the System Status rejection dialog re-queues the edit, and the upload path seals it.
- The runbook's "drain every queue, pause editing elsewhere" ([§7](#7-runbook)) keeps this off the normal path.

Making the ciphertext trigger's refusal transient would close the gap. It would also make a genuinely buggy client jam its whole queue forever, so that trade is declined. Nothing leaks either way.

### 5.3 The sealed image (pure)

`sealChunk(rows, wk) → stagedChunk` (#1292) is a pure function over one bounded page.

The orchestrator pages through this device's `blocks_synced`, which is the server image: every row of the workspace, soft-deleted ones included. For each page it reads, seals, verifies, stages, and then releases it. So neither the plaintext nor the roughly 1.33× ciphertext image is ever held whole in memory.

1. **Seal** each row's three content columns with the existing envelope and AAD (`encodeForWire`). Ids, `parent_id`, ordering and timestamps are untouched.
2. **Verify** by opening every sealed column under the attempt's key before staging the page. A page sealed under any other key never reaches the server.
3. **Compute the bases** for [§5.1](#51-server-freeze-stage-apply-abort): `sha256` of each column's wire value as read, which here is the plaintext. They go out with the staged page and are never persisted on the client either.

**Correctness oracle** (property test): open every row of a staged chunk under the key and compare it with the input. The two must be exactly equal.

**Sizing** is an estimate, not a measurement. Base64url adds a third, and each sealed column adds a 12-byte nonce, a 16-byte tag and the `enc:v1:` prefix. So the staged image is about 1.33× the plaintext plus about 135 bytes per row. Every row changes, so every device re-downloads the whole workspace afterwards.

### 5.4 Attachments

For every media block, soft-deleted ones included (#1291):

1. Get the plaintext bytes from the local byte store, or download them.
2. Seal them under the attempt's key.
3. Upload them to `<ws>/<HMAC(K_id, sha256)>`.

The keyed-path and sealing logic already exists, in `src/sync/crypto/contentKey.ts`, `src/sync/byteTransform.ts` and the upload drain `src/plugins/attachments/uploadDrain.ts`. Reuse it, including the drain's handling of an **occupied path**:

- Paths are write-once and Storage is untrusted, so an object already at the destination is fetched, decoded and hash-verified before it counts as done.
- Its `encb:v1:` header alone proves nothing, because a well-formed poisoned object has one too.
- A mismatch is reported, not accepted.

**Media block ids don't change.** The app derives an attachment's Storage path from the block's `media:hash` plus the workspace mode and `K_id`; it doesn't store it. So after the conversion, an existing media block reads its bytes from the keyed path. Two consequences:

- Each device's local byte store is keyed by the old sha256 content key. The pin upgrade re-keys it ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)), so cached bytes keep rendering.
- Re-capturing a file that was captured before the conversion mints a second media block, at the keyed id. That's accepted. The sha256-derived ids that stay are listed in [§6](#6-what-stays-visible-afterwards).

**Ordering:**

1. **Before** the apply, under the lease, handle each media block's keyed object in this order: record it `intended`, upload it, verify it by authenticated decryption plus a hash check, then mark it `verified`. That way no media block ever points at missing bytes.
2. **After** the apply commits, with the attempt in `cleanup_pending` and the workspace still frozen, the device takes the **lease** (`claim_conversion_lease`) and renews it while it works.
   - Two key-holding devices working at once would interleave their conversions. The lease coordinates honest devices, which is all of them: Storage deletes aren't server-gated by it.
   - Then it takes a **complete** listing of `<ws>/`: paged, with an explicit `limit`/`offset` and a stable name order, through `collectPaged` as the audit does (`src/plugins/attachments/audit/`). A single unpaginated page could hold only valid objects and hide raw ones behind it.
   - The listing is completed before anything is acted on, because deleting while paging by offset would skip objects.

   Let **K** be the keyed paths of every media block in the workspace (recomputed from the server blocks), plus every path recorded in `private.workspace_conversion_objects`. So a resumed cleanup rebuilds the same K. A recorded path whose object is absent is re-uploaded from its source, and one that is present but not yet `verified` is verified. Every listed object outside K is classified by its **content**, never its header:
   - **A raw object** is one whose name equals `hex(sha256(bytes))`, the content-addressed shape every plaintext-mode upload has. Its keyed path is derivable from the name alone: `hex(HMAC(K_id, sha256))`, per `deriveContentKey` in `src/sync/crypto/contentKey.ts`. So convert it in this order: **record** the keyed path `intended`, seal the bytes, upload them, verify, mark the path `verified`, and only then delete the raw object. A crash at any point leaves the raw object as the source, and the recorded path tells the resume what to finish.
     - This covers objects with no media block on the server yet: a capture whose block is still held behind the freeze, or one that never synced. When such a block arrives, its keyed bytes are already there.
   - **Anything else is reported, never deleted.**
     - It can't be a plaintext-mode upload, because every one of those is content-addressed and so lands in the raw branch.
     - It isn't ours either, because every conversion upload is recorded before it starts.
     - So it is foreign: an aborted attempt's in-flight orphan, or something written outside the app. Deleting what we can't explain is a call for a human, so whatever is unexplained at the end is shown to the user.

   A media block with no bytes anywhere (not local, and neither raw nor keyed on the server) is recorded `missing` and shown to the user before `finish`.

   Repeat until a complete listing needs no action.
3. **The proof** has three parts, checked against a final complete listing:
   - **no raw object remains**;
   - **every K path is present**, except those recorded `missing`;
   - **every other object is shown to the user**, who confirms it.

   Every K object was verified by authenticated decryption plus a hash check when this conversion wrote it. "No raw object remains" is what rules out plaintext, because plaintext-mode uploads are always raw. "Every K path is present" catches an expected object that has gone missing. Only then does the client call `finish_workspace_conversion`.

**Why the proof stays true afterwards.**

- A plaintext-mode insert into a frozen or e2ee workspace is refused when it lands ([§5.1](#51-server-freeze-stage-apply-abort)), whenever the client checked.
- Until `finish`, no build with #1293 even tries to upload to the workspace.
- Keyed uploads after `finish` are ciphertext by construction.
- An old build that omits `kmMode` is refused like a plaintext-mode one, so it fails closed rather than relying on the runbook. The periodic ciphertext audit remains a detector for anything that slips past the premises in [§5.1](#51-server-freeze-stage-apply-abort).

**The existing ciphertext audit** (`src/plugins/attachments/audit/`) checks the `encb:v1:` magic and a minimum length (`supabaseAuditIO.ts`) without authenticating anything. So it's a detector and not the proof: a plaintext file that happens to start with those bytes would pass it. The 6-hourly audit workflow will flag the workspace between the apply and step 2; that's expected.

### 5.5 History: archive, then purge

The server's `blocks_history` for the workspace is plaintext and must go. Nothing in the app reads it: the `block_history` tool reads local `row_events` (`src/plugins/agent-runtime/changeHistory.ts`), and only `scripts/supabase-health.mjs` reads the server table.

- **Archive after the freeze.** Once the workspace is frozen, nothing new can be written to its history.
  - The converting client then exports the workspace's `blocks_history` (members can SELECT it under RLS) as chunks sealed under the attempt's key, and the user keeps the file offline.
  - **Completeness is proved, not assumed.** The export pages by an `event_id` cursor in ascending order, never by offset or a single capped response. The client counts the events it archived. `apply` refuses unless that count equals the server's `count(*)` for the workspace ([§5.1](#51-server-freeze-stage-apply-abort)), which the freeze keeps stable. A capped or skipped page then fails loudly before anything is purged.
  - An export taken before the freeze could miss an edit that lands in the gap, which the apply would then delete for good.
  - No plaintext copy is ever written to disk, and the archive is useless without the key.
- **Purge** inside the apply ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Later, if wanted.** Block ids don't change, so a future importer could re-seal archived values under the same per-(block, workspace, column) AAD and insert them through an owner-only RPC. That would turn the archive back into encrypted server history. Re-sealing history in place now would mean building that importer before anything reads its output, so it's deliberately left for later.

Local `row_events` is device-local, never synced, and keyed by block id. No id changes, so it stays intact on every device.

### 5.6 Flow and failure paths

The orchestrator (#1290) refuses to start unless:

- the user owns the workspace;
- the workspace is still plaintext and has no live attempt; if it has one, resume that instead;
- **the pin can be persisted**: `canPersistPins()`, the same preflight the create flow runs (`src/sync/keys/flows/createEncryptedWorkspace.ts`). Otherwise step 7 could never write the upgraded pin;
- **the user confirms the known residue.** That includes a workspace past `cell`, whose synthesized definition ids stay property-name oracles ([§6](#6-what-stays-visible-afterwards)). The preflight names it and asks; it doesn't silently proceed;
- **no live key record would be overwritten.**
  - `keyStore.put` replaces a record outright, and overwriting an applied attempt's key would lose the only key that opens the workspace. So step 1 never runs while an attempt exists.
  - A record found for a plaintext workspace with no attempt is a leftover from a crash before `begin`, because nothing on the server references it. The flow deletes it and starts over with a fresh key and a fresh reveal.
  - It doesn't reuse the leftover: the stored key is non-extractable, so it can't be shown again, and the user may never have saved it;
- the local upload queue is drained, including pending attachment records;
- no rejected rows are pending for the workspace.

**Resume.** On load, an owner device calls `get_workspace_conversion` for each workspace it owns and resumes any live attempt from its state:

- **`staging`, and this device holds a key that opens the attempt's stored canary:** continue staging.
- **`staging` without that key:** do **not** abort. Another device is probably mid-conversion. Show "a conversion is in progress", with two choices: paste its key to take over, or abort it explicitly.
- **`aborting`:** any owner device, key or not, takes the lease, deletes the recorded paths, relists, and calls `finish_abort`.
- **`cleanup_pending`:** with the key, claim the lease, then run [§5.4](#54-attachments) step 2 and the verification, then call `finish`. If another device holds a live lease, wait for it to finish or for the lease to expire. Without the key, prompt for it; there is no abort after the apply.

Abort is never automatic.

| Step | If it fails | State left behind | Recovery |
|---|---|---|---|
| 1. Generate the workspace key, reveal it once, require a retype, and mint its canary. Store the key in the key store **before** any server change | before anything else | nothing changed | retry |
| 2. `begin(ws, canary)` | refused: an attempt exists | another device or tab is converting | resume that attempt with its key, or abort it explicitly |
| 3. Export the sealed history archive (event_id cursor), counting the events | download error | frozen; other devices' edits held | retry, or abort |
| 4. Wait for `blocks_synced` to reach a checkpoint taken after the freeze. Take the content-recovery snapshot ([§7](#7-runbook) step 5), which now covers exactly what will be converted. Then page through: seal → verify → stage | crash, or base mismatch | frozen, partly staged | resume (re-staging is idempotent per block); a mismatch means a pre-freeze read, so re-read that page |
| 5. Under the lease, record → upload → verify each keyed attachment object | partial, or a verification mismatch | recorded ciphertext objects, which an abort deletes | resume from the recorded paths (the occupied-path check makes it idempotent); investigate any mismatch |
| 6. Apply, passing the archived count | refusal (an archive-count mismatch included) or timeout | the transaction rolls back; still frozen | fix the cause and re-apply, or abort |
| 7. Upgrade the local pin | crash after the apply | server e2ee, attempt `cleanup_pending` (still frozen), pin still plaintext | automatic on restart: the stored key opens the canary ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)); resume then finds `cleanup_pending` |
| 8. Under the lease: take a complete paged listing, convert every raw object outside K (recording each first), report anything else, and repeat until a complete listing needs no action | partial, or lease lost | `cleanup_pending`, still frozen; some raw objects remain | resume from `cleanup_pending`: re-claim the lease and rebuild K from blocks plus recorded paths, finishing each `intended` one; conversion is idempotent per object |
| 9. Verify: every row opens; no raw object remains; every K path except `missing` is present; other objects are confirmed by the user; zero history rows remain (the ciphertext audit as a detector only) | a check fails | `cleanup_pending` | investigate; nothing is lost while the key is held |
| 10. `finish`, which ends the freeze | RPC error | `cleanup_pending`, still frozen | retry |

**Losing the key after the apply** makes the server copy unrecoverable. Devices that still hold plaintext `blocks` defer instead of copying, and receive no deletes ([§5.2](#52-client-a-plaintext-pinned-device-that-sees-e2ee)). Their local plaintext survives and can be exported. That's a last line of defence, not a plan: store the key in two independent places before step 2.

## 6. What stays visible afterwards

The design's accepted metadata (§15), unchanged here:

- tree shape and ordering;
- timestamps, including the original creation dates this conversion deliberately keeps;
- edit timing, authorship and `deleted` flags;
- ciphertext lengths;
- `workspaces.name`. The runbook renames it beforehand if it is sensitive ([§7](#7-runbook) step 3).

**Derived ids stay as they are, and some of them remain guess oracles.** Anyone who knows or can enumerate a key can hash it under the public namespace and look for the row. The kinds known today:

| Kind | Key | Who can test it |
|---|---|---|
| Alias seats (`src/data/targets.ts`) | page name | anyone who guesses a name. Open for every e2ee workspace (#719). A seat keeps the hash of the name it had when it was minted, even after a rename. |
| Media blocks (`src/plugins/attachments/mediaCapture.ts`) | sha256 of the file | anyone holding the file |
| Daily notes (`src/plugins/daily-notes/dailyNotes.ts`) | ISO date | anyone (enumerable), which reveals which days have a note |
| Roam import (`src/plugins/roam-import/blockIds.ts`) | Roam uid | holders of the source graph |
| Extension records via `pluginBlockId` / derived identities | whatever the extension chose: external ids (Readwise `user_book_id` and highlight ids, `agent-extensions/readwise.tsx`; Matrix event ids, `agent-extensions/matrix-chat-client.tsx`) and user-chosen keys (Strength Tracker dates and group keys, `agent-extensions/strength-tracker/src/km/store.ts`) | the external service, or anyone who knows the value |
| Synthesized property definitions, **only if** the workspace switched to properties-as-blocks *before* the conversion (`properties_migration` past `cell`; it is forward-only) | the property name, under the public namespace that plaintext synthesis uses (`src/data/internals/propertyDefinitionSynthesis.ts`) | anyone who guesses a property name. Switching after the conversion mints K_id-keyed ids instead ([§7](#7-runbook) step 7) |
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
3. **Workspace name.** If the name is sensitive, rename the workspace now and let the rename sync. The name stays plaintext through the conversion. The old name lingers in dead tuples (step 10 vacuums `workspaces`) and in backups until they age out ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).
4. **Fleet.** This comes before the snapshot, so that the snapshot can cover everything.
   - Every device runs a build with #1293 and #1299, or is wiped (the browser's "clear site data").
   - Every device's upload queue is drained.
   - Editing on other devices pauses for the whole run.
5. **Content-recovery snapshot (not a rollback).** The flow prompts for it once the workspace is frozen and this device has synced a checkpoint taken after the freeze ([§5.6](#56-flow-and-failure-paths) step 4). At that point the snapshot holds exactly what the apply will convert, and no remote edit can land in between.
   - Take two copies, and keep both encrypted offline because both are plaintext:
     - a full local SQLite export, using the raw-SQLite export action (`src/utils/exportSqliteDb.ts`). It holds the `.db` files only.
     - the attachment bytes: download the workspace's Storage prefix, or copy the OPFS byte store from a device that holds every attachment.
   - **The rollback is `abort`, and it exists only before the apply.** After the apply, nothing reverts the workspace to plaintext, because e2ee → none is refused by design.
   - If the key is lost, these snapshots let the content be rebuilt into a *new* plaintext workspace, with the losses of today's import (#401). They're for recovering content, not for undoing the conversion.
6. **Disk headroom.** Postgres can't report free disk, so the operator checks it against the workspace's content size:
   - Measure the size with `select sum(octet_length(content) + octet_length(properties_json) + octet_length(references_json)) from blocks where workspace_id = …`.
   - Confirm the project has free disk of at least about 4× that figure ([§5.1](#51-server-freeze-stage-apply-abort)): staging, the new row versions, and WAL for both. Raise the plan's disk first if it doesn't.
   - Auto-scaling disk grows only on a cooldown, so don't rely on it to absorb a single large burst.
7. **Ordering.** Leave the workspace on the `cell` properties model until afterwards. A workspace that has already switched can't go back, because the state is forward-only. Its definition ids then stay on the [§6](#6-what-stays-visible-afterwards) list until #1297.
   - Property-definition synthesis runs only during the properties-as-blocks switch (`src/plugins/properties-migration/action.ts`). On an e2ee workspace it mints K_id-keyed ids (`resolveSynthesisNamespace` in `src/data/internals/propertyDefinitionSynthesis.ts`).
   - Switching first would mint public, name-derived definition ids.
8. Run the flow from a desktop: the device with the most attachment bytes stored locally.

**After:**

9. Verification passes and `finish` succeeds ([§5.6](#56-flow-and-failure-paths) steps 9–10). Other devices paste the key and upgrade.
10. **Operator: `VACUUM FULL`.**
    - Run it on `blocks`, `blocks_history`, `private.workspace_conversion_rows`, `storage.objects` and `workspaces`.
    - The apply and the purge leave plaintext in dead tuples, Storage metadata rows held the old sha256 paths, and the rename left the old name in `workspaces`.
    - It takes an exclusive lock, so expect a short write stall across the fleet.
11. **Operator: drop leftover ad-hoc tables** from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`) if they still exist. They hold ids and timestamps, not content.
12. **Act on #1289's findings** and record the workspace's "safe from" date ([§8](#8-platform-residue-and-when-it-is-safe-if-breached)).
    - That includes the clean-up #1289 says is needed, such as forcing PowerSync compaction or a reprocess, and purging versioned Storage objects.
    - The live-system claim in §8 doesn't hold until it's done.

## 8. Platform residue, and when it is "safe if breached"

These copies live outside the repo's reach, so none of them is verified here. #1289 confirms each, with its source:

- **Supabase daily backups, PITR and WAL archives** hold plaintext until they age out. Early deletion is probably impossible.
- **Postgres error logs.** Constraint failures can print "Failing row contains (…)".
- **Storage.** Whether deleted objects are versioned or soft-deleted at the storage layer.
- **PowerSync Cloud bucket storage.** It likely keeps superseded operations with full row data until compaction. Open questions: can compaction be forced, and does deploying changed sync rules reprocess from scratch?

So the honest claim has two parts:

- **The live systems.** Two of them are clean once the conversion commits, deletes the old objects and vacuums:
  - **the live database**;
  - **live Storage**, unless #1289 finds deleted objects are versioned.

  The sync service's storage is clean only after whatever #1289 prescribes for it, such as forced compaction or a reprocess. Until all three hold, a breach of the live systems may still expose superseded plaintext. Once they do, it exposes only ciphertext and the metadata in [§6](#6-what-stays-visible-afterwards).
- **The backups.** A breach of a **backup** is safe only after the longest retention window above has passed since that clean-up. The runbook records that date.

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

Plaintext → e2ee is that operation starting from "no key". The stage base is computed over the wire value, so it works unchanged when the source is old-key ciphertext. So the freeze / stage / apply RPCs, the sealed-image builder and the attachment pass should be written over a *source* key that may be absent, not with "plaintext" hard-coded. Rotation then adds one admitted transition (`e2ee → e2ee` with a new canary) and a decrypt step, instead of a second machine. Rotation itself is deliberately not built here.

**The attachment cleanup generalizes the same way, with one difference rotation must design for.**

- [§5.4](#54-attachments) recognizes a *source* object by whether its name is the source content key of its content. For a plaintext source that's `hex(sha256(bytes))`, which can be checked from the bytes alone.
- Under rotation the source key is `hex(HMAC(K_old, h))`.
  - **Old-key objects whose hash is known**, from the workspace's media blocks, can be recognized. Rotation converts them (decrypt under the old key, seal under the new one) and deletes the old copy once the replacement is verified.
  - **Old-key orphans whose hash isn't known** can't be recognized. Their AAD needs `h`, so they can't be authenticated either.
- Leaving those orphans is not acceptable under rotation, because whoever holds the retired key can read them.
  - Rotation keeps the conversion's record-before-upload rule, so an unexplained object is never its own. That lets it delete every object outside the new K, which the conversion leaves to a human ([§11](#11-alternatives-considered)).

## 11. Alternatives considered

- **Export → new e2ee workspace → import.** Rejected, see [§2](#2-decision-convert-in-place-not-by-copy). It would leave an untouched fallback workspace, a real rollback that in-place lacks: here, `abort` before the apply is the only rollback, and the runbook's snapshots are for content recovery ([§7](#7-runbook) step 5). The trade is accepted for the ids and history in-place keeps.
- **Re-iding user-text-derived ids during the conversion.** Moved to #1297, see [§6](#6-what-stays-visible-afterwards). It would save one pass over the affected rows, at the cost of delete/insert pairs, broken links, and a leftover nobody can count, all inside a migration that otherwise only updates.
- **Gradual re-upload through the normal patch path, with no freeze.** Rejected:
  - The ciphertext trigger checks the whole new row, so once the mode flips, an ordinary content-only edit to a row that hasn't been re-sealed yet is rejected.
  - Without the flip, plaintext-pinned peers keep uploading plaintext.
  - Either way, every device sees mixed states.
- **Deleting unexplained attachment objects ("junk") during cleanup.** Rejected. Record-before-upload means one can't be ours, and content-addressing means it can't be a plaintext-mode upload. So it is foreign, and deleting it is a human's call ([§5.4](#54-attachments)).
- **Persisting the bases and re-checking them at apply time.** Rejected. The freeze already guarantees nothing changes between stage and apply, and stored unkeyed plaintext hashes would outlive the plaintext ([§5.1](#51-server-freeze-stage-apply-abort)).
- **Writing the apply's own history rows and deleting them in the same transaction**, instead of suppressing them. This was preferred while `current_user` was the only way to identify the conversion. It was dropped once the attempt-scoped setting existed, because it writes and then strands a full plaintext-plus-ciphertext copy until a vacuum ([§5.1](#51-server-freeze-stage-apply-abort)).
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
| First production run (runbook) | #1288 | #719, #1289, #1290, #1293, #1299 |
| Re-id migration for user-text-derived ids, every e2ee workspace | #1297 | #719 |
| `row_events`: don't log version-only updates | #1299 | — |
