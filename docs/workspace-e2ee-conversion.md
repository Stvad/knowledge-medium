# In-place plaintext → E2EE workspace conversion (single client)

> **Status:** proposal — nothing here is built. Last verified against code: 2026-10-18 (master `13d3f0dc72`).
> Tracking: epic #1295. The pieces are listed in [§13](#13-tracking). A multi-client design is summarized in [§11](#11-appendix-the-multi-client-design); its full text is commit `5df16bfb8a` of this file.

## 1. Goal

Make an existing plaintext workspace end-to-end encrypted **from inside the app, without privileged access**, and keep everything the user has built:

- every block id, so every `((id))`, ref property, backlink and URL keeps working;
- the user-visible timestamps (`created_at`, `user_updated_at`) and authorship;
- extension approvals;
- the device-local change history.

When the conversion finishes, nothing on the backend holds the workspace's *content* in plaintext. A breach then yields only ciphertext plus the metadata in [§7](#7-what-stays-visible-afterwards), with two caveats: an operator still has to scrub dead tuples, and backups have to age out ([§9](#9-platform-residue-and-when-it-is-safe-if-breached)).

The conversion only re-seals. It changes no block id, including the derived ids that hash user text; those belong to #1297.

Non-goals:

- e2ee → plaintext;
- routine workspace-key rotation (key-loss recovery re-keys once, [§8](#8-runbook));
- re-iding derived blocks;
- converting while other clients are active ([§3](#3-the-single-client-contract)).

## 2. Decision: convert in place, not by copy

`docs/e2ee-design.html` §10 says that crossing modes means *export + create a new workspace + import*. That loses most of what a long-lived workspace is worth:

- **Ids can't survive a copy.** `blocks.id` is a global primary key (`blocks_pkey`). A copy would re-id every block and have to rewrite every `((id))`, ref value, `references_json` entry and `parent_id`. The only existing import also drops properties and timestamps (#401).
- **Server history can't follow.** Only the trigger writes `blocks_history`.
- **URLs and extension approvals break.**

Converting in place keeps all of that. Ids don't change, so the per-column AAD needs no rebinding: it covers block id, workspace id, column and schema version (`contentAad` in `src/sync/crypto/aad.ts`). The cost is a one-directional exception to "the encryption mode is immutable" ([§5](#5-the-invariant-we-relax)).

## 3. The single-client contract

The user converts from **one device, in one tab**, and confirms that every other device and tab with this workspace is closed for the duration. **The design does not make conversion safe with other clients active.** What it does is make breaking the contract **fail closed** wherever that's cheap, and **detectable** where it isn't:

| If another client is active and… | What happens |
|---|---|
| …writes blocks after the flip | The existing ciphertext trigger refuses the plaintext write. It is quarantined on that device and recoverable with **Retry** after that device unlocks. Nothing leaks. |
| …writes blocks before the flip | Included. The bundle and its history snapshot are taken after the flip, and the re-seal reads the server image. A write still in flight at the flip makes the purge refuse once ([§6.1](#61-server)), and the next run re-takes the bundle. |
| …uploads an attachment | Current builds defer: the drain sees the server mode ([§6.2](#62-client-prerequisites)). An old build could still leave a plaintext object behind. The 6-hourly ciphertext audit flags it, and re-running the attachment phase converts it. **This is the one accepted gap.** |
| …runs the properties-as-blocks switch | Its definitions keep public, name-derived ids ([§7](#7-what-stays-visible-afterwards)). The converting device refuses that gesture itself; another device isn't fenced. |

## 4. What the backend holds for a plaintext workspace today

| Surface | What it holds | Source |
|---|---|---|
| `blocks` | `content`, `properties_json` and `references_json` in plaintext. Soft-deleted rows keep their content forever. | consolidated initial migration |
| `blocks_history` | INSERT rows hold the full row. UPDATE rows hold the old and new value of every changed column. DELETE rows hold the full old row. Never pruned; only the trigger writes it; no foreign key to `workspaces`. | `20260522062437_add_blocks_history.sql` |
| Storage `attachments` | Unencrypted bytes at `<ws>/<hex(sha256(plaintext))>`. The path itself confirms the content to anyone who can guess the file. Nothing deletes these objects. | `20260625000000_add_attachments_storage.sql`, `src/sync/crypto/contentKey.ts` |
| Derived block ids | uuidv5 ids whose keys may be user text or externally known values. Ids are plaintext in both modes. | [§7](#7-what-stays-visible-afterwards) |
| `workspaces.name` | Plain text in both modes. | `src/data/workspaceSchema.ts` |

No other repo-defined table holds content. Ad-hoc tables left by past scripts hold only ids and timestamps ([§8](#8-runbook)).

## 5. The invariant we relax

Today the mode can't change on either side:

- **Server:** `workspaces_prevent_e2ee_field_change` refuses every change to `encryption_mode` and `wk_canary`.
- **Client:** the local mode pin (`src/sync/keys/modePin.ts`) is set-once.

The conversion admits **exactly one transition**, `none → e2ee` with a well-formed canary.

- **Server.** Only `convert_workspace_to_e2ee` may make the transition. The trigger admits it when `current_user = 'postgres'` **and** a transaction-local `km.conversion = <workspace id>` is set. Only that function sets the second, with `set_config(…, true)`. PostgREST clients can neither be `postgres` nor call `set_config`. e2ee → none stays refused. The only canary change on an e2ee row is #1302's owner-only key-loss re-key ([§8](#8-runbook)), admitted the same way. It gives an owner nothing that `delete_workspace` doesn't already.
- **Client.** `setModePin` stays set-once. A separate `upgradeModePinToE2ee` allows `plaintext → e2ee`, and only after a workspace key opens the server canary.

**Why this doesn't weaken the pin.** The pin stops a server from *downgrading* a workspace. A false plaintext → e2ee claim only stalls a device. The canary's AAD names the workspace, so a canary can't be borrowed from another one.

## 6. Design

### 6.1 Server

This is #1294: one migration and two owner-only SECURITY DEFINER RPCs. There are no staging tables, no freeze and no locks.

- **`convert_workspace_to_e2ee(ws, canary)`.** It refuses unless the caller owns `ws` and its mode is `none`, both checked in this transaction. It then sets `encryption_mode = 'e2ee'` and `wk_canary`, and nothing else. Rows stay plaintext until the client re-seals them, and their prior values are still in `blocks_history`.
- **`purge_workspace_history(ws, through_event_id, archived_count)`** runs with a raised `statement_timeout`, as `delete_workspace` has. It refuses unless all of these hold:
  - the caller owns `ws`, its mode is `e2ee`, and `through_event_id` isn't null (an empty history exports `0`, [§6.3](#63-the-flow));
  - **every** block row of `ws` has all three content columns as `enc:v1:` envelopes, which the server checks itself;
  - `count(*)` of `ws`'s history rows with `event_id ≤ through_event_id` equals `archived_count`;
  - **every** history row of `ws` after `through_event_id` is a re-seal write: `op = 'U'`, `changed_columns ⊆ {content, properties_json, references_json, updated_at}`, and the new values are envelopes. So the server can prove that nothing but the conversion wrote after the archive point.

  It then deletes every history row of `ws`. That includes the re-seal writes, whose `before_diff` holds the old plaintext.
- **Bucket limit.** Raise `attachments.file_size_limit` by the binary envelope's overhead (`BINARY_ENVELOPE_OVERHEAD_BYTES`, 36 bytes; round up to 64).
  - `captureMedia` caps a plaintext capture at exactly 50 MiB (`DEFAULT_MAX_CAPTURE_BYTES`). Sealing such a file adds the overhead, and Storage would return a permanent 413.
  - The capture cap itself stays where it is. It already accounts for the overhead in e2ee mode, so new uploads gain nothing from the raise.
- **Export index.** Add `(workspace_id, event_id)` on `blocks_history` so the export can page by id ([§6.3](#63-the-flow)).

Rows that stay plaintext between the flip and the re-seal are safe from other writers: `blocks_require_ciphertext_for_e2ee` refuses any write to an e2ee workspace that isn't fully sealed. pgTAP pins every refusal above.

### 6.2 Client prerequisites

These ship to **every** device before any conversion runs. Each of them is also useful on its own.

- **#1299 — `row_events` skips version-only updates.** The re-seal bumps every row's `updated_at`, and the local `blocks_row_event_update` trigger would otherwise append a full OLD and NEW snapshot of every row on every device. The check compares the logged projection (`blockJsonObjectSql`) minus `updatedAt`, with `userUpdatedAt`'s `coalesce` fallback neutralized.
- **#1293 — a device whose pin says plaintext while the server says e2ee:**
  - **Materialize defers.** Local `blocks` keep their plaintext.
  - **Block uploads are held**, so nothing plaintext is sent.
  - **The attachment drain defers**, and confirms the live mode before every upload.
  - **An unlock prompt** appears (`WorkspaceKeyGate`).
  - **A one-way pin upgrade** runs, separate from `unlockWorkspaceWithKey`, which pins first and throws on a plaintext pin:
    1. Validate the canary and store the key.
    2. Write a durable marker.
    3. `upgradeModePinToE2ee`.
    4. `repo.drainSyncWorkspace`, which uses scope `'all'`, because updating `needs_apply` doesn't wake the observer. Then `runUploadRecovery`, then clear the marker.

    At startup a marker resumes from the current pin, and it's cleared only once the pin reads e2ee and the drain is done.
  - **Every remote attachment path is derived when it's used**: drain upload, 409 verify, and `recoverFailedUploads`'s probe. Each comes from `contentHash`, the live mode and `K_id`, never from `rec.contentKey`, which stays the OPFS key. A record that crosses the mode change (`staged`, `pending` or `failed`) therefore goes to the right path with no re-keying.
  - **A device that already copied ciphertext** into `blocks` (an old build that ran across the conversion) isn't repaired in place, because that would flood `row_events`. It gets the gated reset ([§8](#8-runbook)).
- **#1300 — the upload classifier treats `25006` (read-only database, e.g. a full disk) as transient**, so a full disk doesn't quarantine everyone's edits.

### 6.3 The flow

The flow is one guarded, in-app flow on the converting device (#1290). It has no server-side state machine. **The phase is read off the server every time**, after a checkpoint, so a reload or crash resumes from what the server shows:

| Server shows | Phase |
|---|---|
| mode `none` | preflight → key → flip |
| mode `e2ee`; a block row isn't fully sealed, or a history row remains | recovery bundle (unless this device holds a verified one) → re-seal → verify → purge |
| mode `e2ee`; every row sealed, no history | pin upgrade → attachments → done |

The last phase never reads "done" off the server. Its steps are idempotent: the pin upgrade is skipped on a pin that already reads e2ee, and the cleaner's complete listing is its own proof. So it runs in full on every resume, and the flow reports done only after this run's proof passes. Every run, resumed ones included, first takes the lock, sets read-only and re-confirms the contract.

**0. Preflight.** It refuses unless all of these hold:
- the user owns the workspace, and it's plaintext;
- the user confirms the single-client contract ([§3](#3-the-single-client-contract));
- `repo.setReadOnly(true)` is set on this device for the whole run, and the properties-as-blocks gesture is refused here while converting. Read-only doesn't stop UI-state, preference or automation writes (`CHANGE_SCOPE_POLICIES` in `src/data/api/changeScope.ts`), which still upload. That's why the bundle comes after the flip;
- the workspace shows **zero sync divergence**, after a drain and a checkpoint. That means no `unapplied` or `stranded` rows, computed as `agent health` reports `syncDivergence` (`src/plugins/agent-runtime/healthCommand.ts`). Otherwise the bundle and the re-seal source could be stale;
- the upload queue is drained, attachment records included, and no rejected rows are pending;
- `canPersistPins()` passes, and the key store is durable (not `createWorkspaceKeyStore`'s in-memory fallback);
- the user confirms the residue named in [§7](#7-what-stays-visible-afterwards), such as a workspace already past `cell`;
- the user confirms disk headroom ([§8](#8-runbook)).

**1. Key.**
- `mintWorkspaceKey`, extracted from `createEncryptedWorkspace.ts`, generates and imports the key, derives `K_id`, mints the canary, then re-parses the **displayed** string and opens the canary with it. It also probes a durable key-store write.
- The key is revealed once, the user retypes it, and it's stored durably.
- A `navigator.locks` lock per (user, workspace) is held for the whole flow.
- A key record found for this workspace counts as a leftover only when a fresh server read shows mode `none`. Even then it's moved aside, never deleted.

**2. Flip.** `convert_workspace_to_e2ee(ws, canary)`. This device keeps its plaintext pin, so with #1293 it defers instead of copying ciphertext, and its local plaintext stays intact for the bundle and for verification.

**3. Recovery bundle.** One zip, written through the existing export save path (`chooseRawSqliteExportFile`: File System Access picker, OPFS fallback). It's taken right **after** the flip:
- The flip changes no block row, and this device defers, so the bundle still holds the pre-conversion content.
- From the flip on, the server refuses plaintext writes, and #1293 holds this device's uploads, its UI-state writes included. So nothing but the re-seal can land in history after the snapshot. The one exception is a write already in flight at the flip, which the purge's checks catch.

It holds:
- **`local.db`.** The raw SQLite export (`src/utils/exportSqliteDb.ts`). It includes the device-local history (`row_events`, `command_events`).
- **`server-history.jsonl`.** The workspace's `blocks_history`, which members can read under RLS (`blocks_history_read`). The export works like this:
  1. Snapshot `through` = `coalesce(max(event_id), 0)` and an exact count, in one query. An empty history therefore still has a boundary, and every later row is checked.
  2. Page by `event_id` (`> cursor`, `≤ through`, ordered, ≤1000 rows per request), never by offset.
  3. Stream one row per line, with every column verbatim: `event_id`, `block_id`, `op`, `semantic_op`, `changed_columns`, `actor`, `event_time`, `before_diff`, `after_diff`.
- **`attachments/`.** Every media block's plaintext bytes, from the local byte store or downloaded from the raw Storage objects.
- **`manifest.json`.** The workspace id, `through`, the row count, a sha256 of each part, the column list and the export time.

The flow then **re-opens the file and verifies it**: the line count matches, `event_id`s are strictly increasing and end at `through`, and the hashes match. It then keeps the manifest's `through`, count and hashes on this device (localStorage, per user and workspace), so a resumed run reaches the purge without re-picking the file. The re-seal never starts without that record. Until the bundle verifies, every device defers, and nothing is lost.

The bundle is plaintext, as sensitive as the database. Store it on an encrypted volume or as a password-manager attachment. It isn't sealed under the workspace key, because then it would be unreadable exactly when it's needed: after the key is lost. **It's a point-in-time content snapshot, not a rollback.** There's no going back after the flip.

**4. Re-seal** (#1292). Page through this device's `blocks_synced`, which is the server image: every row of the workspace, soft-deleted ones included. For each bounded page:
1. **Seal.** `sealChunk` seals the three content columns under the existing envelope and AAD (`encodeForWire`).
2. **Check the seal.** Open every column under the key before sending it.
3. **Send it.** Call the existing `apply_block_patches` RPC **directly**: SECURITY INVOKER, granted to `authenticated`, one `{id, content, properties_json, references_json, base_updated_at}` per row. It bypasses the PowerSync queue, so the pin can stay plaintext.

The step keeps no local state. After a checkpoint, any row still not sealed in `blocks_synced` is simply re-sent. It can take hours for a large workspace, so the flow keeps a progress view and a wake lock.

**5. Verify.** Wait for a checkpoint in which every row of the workspace in `blocks_synced` is fully sealed. Then check each row against **the server's own record of its re-seal**:
- **The record.** Each row's first history row after `through` whose new values are envelopes is its re-seal write. That row's `before_diff` holds the exact plaintext each content column had just before it was sealed, including any write that landed in between.
- **The check.** Page that history the way the export does. Decrypt each row in `blocks_synced`, without going through materialization, and require every column to equal its `before_diff` value.

The record is durable on the server until the purge and needs nothing local, so a crash at any point leaves verification possible. The other columns need no check here: the purge already refuses any write after `through` that touched more than the content columns and `updated_at`.

A row that fails is re-sent from that same `before_diff` value and verified again. Only a clean pass proceeds. This catches mapping bugs that a seal check alone can't see: the AAD binds the column, so a swapped column would pass the envelope trigger and then fail to open.

**6. Purge.** `purge_workspace_history(ws, through, count)`, with `through` and `count` taken from the verified bundle's record. The server re-checks all four conditions ([§6.1](#61-server)). A refusal clears the record, so the next run re-takes the bundle at a later `through`. Since nothing plaintext can enter history after the flip, a write in flight at the flip refuses only once. A refusal that survives a re-take means a row isn't sealed or the contract was broken.

**7. Pin upgrade on this device** (#1293). The drain decrypts every row into `blocks`. Each update is version-only, so #1299 keeps `row_events` clean.

**8. Attachments** (#1291). One cleaner, this device, using the member client's Storage API.

- **One classification rule**, written once next to `deriveContentKey`. For bytes `b` under name `n`:
  - the object is **raw** iff `n == hex(sha256(b))`;
  - its **keyed** name is `hex(HMAC(K_id, sha256(b)))`.

  The rule reads content, never a header or the name's shape, since both kinds of name are 64 hex characters.
- **One verification helper**, `verifyStoredObject → match | mismatch | undecodable`. It replaces the three copies in `resolver.ts`, `uploadDrain.ts` and `uploadRecovery.ts`.
- **Repeat until a complete listing needs no action:**
  1. List `<ws>/` **completely before acting**. Page by name, and recurse into folder entries, which Storage returns as virtual folders for nested paths. Only this device deletes, so the listing can't shift underneath it.
  2. **Raw object:** seal it, upload it to the keyed path, check it with `verifyStoredObject` (a 409 on an occupied path goes through the same check), then delete the raw object.
  3. **The keyed path of a media block, or the keyed name of a listed raw object:** keep it.
  4. **Anything else:** delete it by its full path and report it. That includes nested objects, since content-addressed uploads are flat.
- **The proof:** no raw object remains, and every media block's keyed path is present. Where no source exists anywhere, the path is reported before the flow finishes.
- **Media block ids don't change.** The app derives an attachment's path from `media:hash`, the mode and `K_id`. A re-capture of a pre-conversion file mints a second block, which is accepted.

**9. Done.** Only after step 8's proof passes in this run, the flow lifts read-only, then reports the operator follow-ups ([§8](#8-runbook)) and the "safe from" date ([§9](#9-platform-residue-and-when-it-is-safe-if-breached)).

| Phase | If it fails | Recovery |
|---|---|---|
| Preflight, key | before the flip | nothing changed; retry |
| Flip | RPC error | nothing changed; retry |
| Bundle | can't be saved, or doesn't verify | every device defers; retry |
| Re-seal | crash, or an RPC error | resume: re-send what's still plaintext |
| Verify | rows don't match | re-send them; history and local plaintext are intact |
| Purge | refused | the next run re-takes the bundle and retries. If it refuses again, investigate. Nothing is lost. |
| Pin upgrade, attachments | crash, or partial | the last phase re-runs in full; the pin upgrade also resumes at startup (marker) |

**Key loss.** Before the purge, nothing is lost: history and every device's local plaintext still exist. After it, the server copy can't be recovered, and the recovery procedure is in [§8](#8-runbook).

### 6.4 Other devices

After the conversion, each device that opens the workspace sees the mismatch (#1293). It defers, prompts for the key, upgrades its pin one way, and drains. Its local `row_events` survive, and #1299 keeps the drain from adding noise to them.

## 7. What stays visible afterwards

Visible metadata:
- **What the e2ee design's §15 already lists:** tree shape, ordering, edit timing, authorship, `deleted` flags, and which column changed.
- **Added by this conversion:**
  - ciphertext lengths;
  - the original timestamps, which are deliberately kept;
  - `workspaces.name`. The runbook renames it first if it's sensitive.

**Derived ids that remain guess oracles** (#1297, after #719):

| Kind | Key | Who can test it |
|---|---|---|
| Alias seats (`src/data/targets.ts`) | page name, as minted | anyone who guesses a name |
| Media blocks (`src/plugins/attachments/mediaCapture.ts`) | sha256 of the file | anyone holding the file |
| Daily notes | ISO date | anyone (enumerable) |
| Roam import | Roam uid | holders of the source graph |
| Extension records (`pluginBlockId`) | e.g. Readwise book and highlight ids, Matrix event ids, Strength Tracker dates and group keys | the external service, or anyone who knows the value |
| Synthesized property definitions, only if the workspace switched before converting (it can't switch back) | property name | anyone who guesses a name |
| Kernel pages, seeds, user page, state children | code-owned | anyone; this reveals which features are used |

The conversion doesn't re-id these. Re-iding means a delete plus an insert plus a pointer rewrite, which loses blocks on peers that haven't unlocked, breaks links and `row_events`, and leaves a remainder that can't be counted. That work belongs to #1297, for every e2ee workspace.

## 8. Runbook

The first production run is #1288.

**Before:**
1. **Deploys:**
   - #1299, #1293 and #1300 reach **every** device;
   - #1294's migration is applied;
   - #719 has shipped, so new `[[links]]` stop minting public ids;
   - #1302's recovery path exists, because the safety net has to exist before an irreversible step on the main workspace.
2. **No wipe shortcut.**
   - Clearing site data erases every workspace key, pin, `row_events` history, extension approval and pending attachment on that browser profile.
   - The **gated reset**, for a device that copied ciphertext: drain every workspace's queue; make sure no attachment records are pending or failed; confirm every e2ee key on that profile is saved elsewhere; take a raw SQLite export; then reset.
3. **Fleet.** Drain every device's queue, then close every other tab and device.
4. **Key custody.** Two independent places, such as a password manager and paper. The recovery bundle goes alongside them.
5. **Workspace name.** Rename it first if it's sensitive.
6. **Disk headroom.**
   - Measure `sum(octet_length(content) + octet_length(properties_json) + octet_length(references_json))` over the workspace.
   - The re-seal writes new row versions (about 1.33×), history rows holding both old and new values (about 2.3×), and WAL for all of it.
   - So confirm free disk of about **6×** that figure, plus room for `VACUUM FULL` to copy each table it rewrites. Auto-scaling disk grows only on a cooldown.
7. **Ordering.** Stay on the `cell` properties model until afterwards. Synthesis then mints K_id-keyed ids.
8. **Rehearse** the conversion and the key-loss recovery on a scratch workspace first.
9. Run from a desktop that holds the most attachment bytes locally.

**After:**

10. Open other devices one at a time, and paste the key on each.
11. **Operator: `VACUUM FULL`** on `blocks`, `blocks_history`, `storage.objects` and `workspaces`.
    - It takes ACCESS EXCLUSIVE locks, which block reads **and** writes on each table for a time proportional to the table's **total** size across all workspaces. Schedule it.
    - `pg_repack`, if available, is the non-blocking alternative.
    - This step, and the next two, are platform operations a client can't do.
12. **Operator:** drop leftover ad-hoc tables from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`).
13. **Act on #1289's findings** and record the "safe from" date.
14. **Take later recovery points.** From time to time, on an unlocked device, take step 3's bundle again without its server history, which is ciphertext by then. Keep it with the key. A raw SQLite export alone isn't a recovery point: attachment bytes live outside the database (`src/plugins/attachments/byteStore.ts`), and their remote copies are sealed under the key.

**Key-loss recovery** (#1302). This applies after the purge. Before it, nothing is lost. It **re-keys the workspace in place**: nothing is deleted, so no workspace or block id is ever free for another caller to claim.
1. **Pick the newest recovery point.** Each is a bundle-shaped zip, `local.db` plus attachment bytes. In order of preference:
   - a step-14 recovery point;
   - the conversion's bundle;
   - one taken from a device that still defers, whose `blocks` keep their pre-conversion plaintext.
2. **Re-key.** A new key is minted and stored as in step 1. An owner-only RPC replaces the canary on the e2ee row ([§5](#5-the-invariant-we-relax)).
3. **Restore every row** through `apply_block_patches`, with each row's base taken from the server row.
   - **Each patch carries the whole row.** That means the snapshot's content columns, sealed under the new key, **and** its other columns (`parent_id`, `order_key`, `deleted`, `created_at`, `user_updated_at`, `created_by`, `updated_by`). A move, reorder, delete or undelete made since the snapshot is undone too.
   - **Rows the snapshot lacks are tombstoned:** sealed empty and marked deleted.
   - **Progress is read by trial decryption.** An envelope doesn't say which key sealed it. So a row counts as restored only when it opens under the new key and equals the snapshot's row. A crash anywhere after the canary change resumes by re-checking every row against the same recovery point. The restore is done only when every row passes.
   - History then holds only ciphertext under the lost key, so the purge is optional.
4. **Attachments.** Stage the recovery point's bytes, then run step 8's cleaner. Objects under the old `K_id` are neither raw nor a media block's new keyed path, so its "anything else" rule deletes them.
5. **Other devices.**
   - **Every device checks its key record against the server canary on entry.** A record that doesn't open the current canary counts as locked, so the device prompts for the new key instead of quarantining every row. Today `resolveWorkspaceEntry` only checks that a record with `K_id` exists, so #1302 adds that check.
   - A deferring device takes #1293's pin upgrade.
   - No pin changes direction, so nothing needs retiring.

**It's point-in-time, not lossless.** It restores the snapshot's state. Every edit, page and attachment made after the snapshot is lost, because nothing else holds that plaintext. That's why the key lives in two places, and why step 14 exists.

## 9. Platform residue, and when it is "safe if breached"

#1289 confirms each of these:

- **Supabase backups, PITR and WAL archives** hold plaintext until they age out.
- **Postgres error logs** may print failing rows.
- **Deleted Storage objects** may be versioned or soft-deleted.
- **PowerSync bucket storage** likely keeps superseded operations until compaction. It must also be confirmed that compaction or a reprocess never yields a checkpoint missing a row, because a missing row would hard-delete on every device that defers.

What follows from that:
- **Live systems:** after the conversion, the `VACUUM FULL` and #1289's clean-up, a breach of the live systems exposes only ciphertext and the [§7](#7-what-stays-visible-afterwards) metadata.
- **Backups:** a breach of a backup is safe only once the longest retention window has passed since that clean-up.

## 10. What the workspace gives up

- **Server-side anomaly detection.** The L5 detectors in `scripts/supabase-health.mjs` are plaintext-only.
- **Server-history procedures** such as `scripts/dangling-refs/README.md`.
- **The consistency check** (#233).
- **Future server-side features:** search, AI, and server-rendered share links.
- **Recovery without the key.**
- **One full re-download** on every device.
- **A maintenance window:** a single client for the run.

## 11. Appendix: the multi-client design

Converting while other clients may be active, or making the flow resumable by another device, needs much more. Commit `5df16bfb8a` of this file holds the full design. In outline:

- **A durable attempt state machine.** `staging → applied → cleanup_pending`, with owner RPCs, a staging table, an apply RPC, `apply_generation` and `verified_generation` binding the purge to a verified apply, and sealed per-row `verify_record`s so another device can verify.
- **A server freeze.**
  - A block trigger returns `PT429`, which clients retry.
  - It has an attempt-scoped exemption and a trigger-name ordering constraint.
  - `begin` serializes with a SHARE lock on `blocks`, a per-workspace advisory lock, and a row lock on `workspaces`.
- **An insert-time Storage fence.** Uploads declare `kmMode`, and a policy function admits only `e2ee` under a frozen or e2ee workspace. It rests on three Storage premises that are still unverified.
- **Upload parking** (#1301), so one held workspace can't stall a device's queue.
- **A keyset `storage.objects` listing RPC** that stays complete under concurrent cleaners, with record-before-upload and sparing of raw objects' destinations.
- **Takeover, abort and abandon**, and a property-migration claim with fencing tokens.

What it adds is safety against concurrent actors. What it keeps from this design is the correctness core: the sealing, verify-before-purge, the archive read-back, and the attachment rule.

## 12. Alternatives considered

- **Export → new workspace → import.** Rejected ([§2](#2-decision-convert-in-place-not-by-copy)).
- **The multi-client design** ([§11](#11-appendix-the-multi-client-design)). Deferred: about three times the work, to cover concurrency the single-client contract excludes.
- **An operator-run conversion with service-role scripts.** Smaller still, but it needs privileged access and gives other users no in-app path.
- **Re-sealing before the flip.** Rejected: a plaintext-pinned device would copy the ciphertext straight into `blocks`.
- **A local verification record per re-sealed row.** Rejected: it has to survive a crash between a row's commit and the verify. The server's history already holds each row's pre-seal plaintext durably until the purge.
- **Taking the bundle before the flip.** Rejected. Read-only still uploads UI-state, preference and automation writes, so the history snapshot could be raced right up to the flip. Rejecting those scopes too would break collapse, layout and preference changes for a run that can take hours. After the flip, the server refuses plaintext writes and this device holds its uploads.
- **Key-loss recovery by delete and same-id restore.** Rejected. Every globally unique id, the workspace's and each block's, would have to be reserved across the gap. It also needed a restore RPC, a same-id importer and a pin-retirement gesture. Re-keying in place leaves no gap, and reuses the conversion's own steps.
- **Re-sealing through the PowerSync queue.** Rejected. It would need the pin flipped first, and would push hundreds of thousands of rows through the device-wide FIFO queue. Calling the patch RPC directly avoids both.
- **Sealing the recovery bundle under the workspace key.** Rejected: that makes it unreadable exactly when it's needed.
- **Suppressing history during the re-seal.** Not possible without privileged access. The purge removes the re-seal writes, and the disk headroom check accounts for them.

## 13. Tracking

| Piece | Issue | Waits on |
|---|---|---|
| Epic | #1295 | — |
| Server: flip RPC, guarded purge RPC, mode admit, bucket limit, export index | #1294 | — |
| Clients: mismatch defer/hold, use-time path derivation, unlock prompt, one-way pin upgrade | #1293 | — |
| `row_events`: skip version-only updates | #1299 | — |
| Upload classifier: 25006 is transient | #1300 | — |
| Sealing pages | #1292 | — |
| Attachment conversion | #1291 | — |
| The in-app flow, including the recovery bundle | #1290 | #1291, #1292, #1293, #1294 |
| Key-loss recovery: owner re-key RPC, re-seal from a snapshot, tombstones | #1302 | — |
| Platform retention spike | #1289 | — |
| First production run | #1288 | #719, #1289, #1290, #1293, #1299, #1300, #1302 |
| Re-id migration (all e2ee workspaces) | #1297 | #719 |
| Upload parking (multi-client only, deferred) | #1301 | — |
