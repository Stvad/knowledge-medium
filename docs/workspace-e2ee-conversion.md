# In-place plaintext → E2EE workspace conversion (single client)

> **Status:** design; implementation in progress. Epic #1295 and [§13](#13-tracking) show which pieces have landed. Last verified against code: 2026-10-19, against master `afc7fe5e09` and the open PRs for #1299, #1292, #1294 and #1293. Code wins where they differ.
> Tracking: epic #1295. The pieces are listed in [§13](#13-tracking). A multi-client design is summarized in [§11](#11-appendix-the-multi-client-design); its full text is commit `5df16bfb8a` of this file.

## 1. Goal

Make an existing plaintext workspace end-to-end encrypted **from inside the app, without privileged access**, and keep everything the user has built:

- every block id, so every `((id))`, ref property, backlink and URL keeps working;
- the user-visible timestamps (`created_at`, `user_updated_at`) and authorship;
- extension approvals;
- the device-local change history.

When the conversion finishes, nothing on the backend holds the workspace's *content* in plaintext. A breach then yields only ciphertext plus the metadata in [§7](#7-what-stays-visible-afterwards), with two caveats: an operator still has to scrub dead tuples and rebuild PowerSync's sync data, and backups and logs have to age out ([§9](#9-platform-residue-and-when-it-is-safe-if-breached)).

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
| …writes blocks before the flip | Included. The flip waits for every in-flight write to commit ([§6.1](#61-server)), the bundle's history snapshot is taken after it, and the re-seal reads the server. |
| …writes blocks after the flip | The ciphertext trigger refuses the plaintext write ([§6.1](#61-server)). That device quarantines it, recoverable with **Retry** once it unlocks. Nothing leaks. |
| …tries to unlock the workspace mid-conversion | Refused: no device unlocks or upgrades its pin while the workspace's conversion phase is `sealing` ([§6.2](#62-client-prerequisites)). |
| …uploads an attachment | #1293 builds defer: the drain checks the live mode. An older build could still leave a plaintext object behind. The 6-hourly ciphertext audit flags most such objects. It reads only an object's first bytes, so a plaintext file that happens to begin with `encb:v1:` passes it. The definitive check is the owner's **Clean up attachments** gesture, which classifies by content and converts what it finds, at any time, conversion or not ([§6.3](#63-the-flow) step 8). Run it once every device is back after a conversion. **This is the one accepted gap.** |
| …runs the properties-as-blocks switch | Not fenced on another device. See [§7](#7-what-stays-visible-afterwards) and runbook step 7. |

## 4. What the backend holds for a plaintext workspace today

| Surface | What it holds | Source |
|---|---|---|
| `blocks` | `content`, `properties_json` and `references_json` in plaintext. Soft-deleted rows keep their content forever. | consolidated initial migration |
| `blocks_history` | INSERT rows hold the full row. UPDATE rows hold the old and new value of every changed column. DELETE rows hold the full old row. Never pruned while its workspace exists; in normal operation only the trigger writes it (`service_role` holds `GRANT ALL`); no foreign key to `workspaces`. | `20260522062437_add_blocks_history.sql` |
| Storage `attachments` | Unencrypted bytes at `<ws>/<hex(sha256(plaintext))>`. The path itself confirms the content to anyone who can guess the file. Nothing deletes these objects. | `20260625000000_add_attachments_storage.sql`, `src/sync/crypto/contentKey.ts` |
| Derived block ids | uuidv5 ids whose keys may be user text or externally known values. Ids are plaintext in both modes. | [§7](#7-what-stays-visible-afterwards) |
| `workspaces.name` | Plain text in both modes. | `src/data/workspaceSchema.ts` |

No other repo-defined table holds content. Ad-hoc tables left by past scripts hold only ids, timestamps and authorship ([§8](#8-runbook)).

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

This is #1294: one migration, three owner-only SECURITY DEFINER RPCs, and one small table.

- **`workspace_conversions`**, one row per workspace mid-conversion: `workspace_id` (primary key, cascading on workspace delete) and `phase`, `sealing` or `cleaning`. No row means no conversion in progress. It isn't synced; clients read it over PostgREST.
  - **Who changes it.** RLS lets members read it, and there is no write policy, so only the three RPCs below can write it, each in its own transaction. The flip inserts `sealing`, the purge moves it to `cleaning`, and `finish_conversion` deletes it. The flip refuses any workspace whose mode isn't `none`, so a conversion can't start again.
  - **What it means.** While it's `sealing`, the server may still hold plaintext, and #1293 refuses every unlock ([§6.2](#62-client-prerequisites)). While it's `cleaning`, only attachment cleanup is left. The flow reads its phase from it ([§6.3](#63-the-flow)).
- **`convert_workspace_to_e2ee(ws, canary)`.** It refuses unless the caller owns `ws` and its mode is `none`. It first locks the workspace row (`FOR NO KEY UPDATE NOWAIT`), so a concurrent flip of the same workspace refuses there rather than queueing. It then makes its changes and takes `LOCK TABLE blocks IN SHARE MODE NOWAIT` **last**, so no later acquisition can wait while it holds the shared lock. It refuses with a retryable lock-not-available error if any block write is in flight. Holding the lock means every write that began before the flip has committed, and is in history, before the mode changes, and every later write sees `e2ee`. `NOWAIT` matters because `blocks` is shared by every workspace. A lock request that waits would queue every tenant's writes behind it, and anyone can call the flip on a plaintext workspace of their own. The flow retries with backoff ([§6.3](#63-the-flow) step 2); an autovacuum of `blocks` can make it retry for a while. Its changes are: `encryption_mode = 'e2ee'` and `wk_canary` set, the `sealing` row inserted, and nothing else. Rows stay plaintext until the client re-seals them, and their prior values are still in `blocks_history`.
- **`purge_workspace_history(ws, through_event_id, archived_count)`** runs with a raised `statement_timeout`, as `delete_workspace` has. Refusals raise one of two dedicated SQLSTATEs, so the client can tell them from a transport error and from each other: `KMC01` means fix the state and retry (a row isn't sealed), and `KMC02` means the bundle is stale (the count, or a history row after `through`, shows a write outside the re-seal). It refuses unless all of these hold:
  - the caller owns `ws`, its mode is `e2ee`, its phase is `sealing`, and `through_event_id` isn't null (an empty history archives through `0`);
  - **every** block row of `ws` has all three content columns as `enc:v1:` envelopes, which the server checks itself;
  - `count(*)` of `ws`'s history rows with `event_id ≤ through_event_id` equals `archived_count`. This catches a row that committed late with an id below the boundary;
  - **every** history row of `ws` after `through_event_id` is a re-seal write: `op = 'U'`, `changed_columns ⊆ {content, properties_json, references_json, updated_at}`, and the new values are envelopes. So no plaintext entered history after the archive point.

  It then deletes every history row of `ws`, the re-seal writes included (their `before_diff` holds the old plaintext), and moves the phase to `cleaning`.

  It holds no lock on `blocks` across the delete. That would stall every workspace's writes for minutes, and it buys nothing:
  - a write that commits before the delete's snapshot is counted by it, so a foreign row raises `KMC02`;
  - one that commits later can only be ciphertext, because the trigger refuses plaintext, so it survives as ciphertext history. That's accepted.
- **`finish_conversion(ws)`.** It refuses unless the caller owns `ws` and the phase is `cleaning`, then deletes the row. The client calls it only after the attachment proof passes; the server can't check that proof itself.
- **Bucket limit.** Raise `attachments.file_size_limit` by the binary envelope's overhead (`BINARY_ENVELOPE_OVERHEAD_BYTES`, 36 bytes; round up to 64). Supabase caps every bucket at the project-wide upload limit, so on the hosted project this raise only takes effect up to that setting. The conversion depends on it only for an object within 36 bytes of the 50 MiB cap: such an object seals only once the upload limits are raised to its sealed size (step 0, step 8).
  - `captureMedia` caps a plaintext capture at exactly 50 MiB (`DEFAULT_MAX_CAPTURE_BYTES`). Sealing such a file adds the overhead, and Storage would return a permanent 413.
  - The capture cap itself stays where it is. It already accounts for the overhead in e2ee mode, so new uploads gain nothing from the raise.
- **Export index.** Add `(workspace_id, event_id)` on `blocks_history` so the export and verify can page by id.

**After the flip, the server refuses every plaintext write**: `blocks_require_ciphertext_for_e2ee` refuses any write to an e2ee workspace whose new row isn't fully sealed. It reads the mode without a lock, which is why the flip takes the table lock. pgTAP pins every refusal above, plus a write held open across the flip.

### 6.2 Client prerequisites

These ship to **every** device before any conversion runs. Each of them is also useful on its own.

- **#1299 — `row_events` skips version-only updates.** The re-seal bumps every row's `updated_at`. Without this, the local `blocks_row_event_update` trigger would append a full OLD and NEW snapshot of every row on every device.
- **#1293 — a device whose pin says plaintext while the server says e2ee.** This reads the synced `workspaces` row, which reverses the resolver's "pin and key store only" contract (`src/sync/keys/resolver.ts`). It does so in the fail-closed direction only: the server's mode can make a device defer, never decrypt less.
  - **Materialize defers.** Local `blocks` keep their plaintext.
  - **Block uploads are held**, so nothing plaintext is sent. A held entry stays in `ps_crud`, and the core publishes no checkpoint until `ps_crud` is empty (the download-hold note on the upload triggers in `src/data/internals/clientSchema.ts`). So a held write also stops that device's downloads, for every workspace, until it unlocks. The gate below keeps such writes rare; #1301 would remove the stall.
  - **The attachment drain defers**, and confirms the live mode before every upload.
  - **The gate (`WorkspaceKeyGate`) reads the workspace's `workspace_conversions` row.**
    - While its phase is `sealing`, no device unlocks or upgrades its pin. The gate shows that a conversion is in progress, and on the converting device that's where the flow resumes.
    - Otherwise the gate prompts for the key.
    - While the phase is `cleaning`, the owner's devices also offer to finish the conversion, so a crash during cleanup resumes from the server's state, not from a local marker. A device without the bundle record first asks for the saved bundle and verifies it as in step 3 (its server history is gone by then). Only once the bundle has been consulted can any media count as unrecoverable.
  - **A one-way pin upgrade.** It's separate from `unlockWorkspaceWithKey`, which pins first and reports a plaintext pin as a storage failure without storing the key. The steps:
    1. Validate the canary and store the key.
    2. Write a durable marker.
    3. Run `upgradeModePinToE2ee`.
    4. Drain the workspace (`repo.drainSyncWorkspace`) and run upload recovery.
    5. Clear the marker.

    At startup, a marker resumes the upgrade from the current pin.
  - **Every attachment address is derived when it's used**: drain upload, 409 verify, `recoverFailedUploads`'s probe, and the resolver. Each comes from `contentHash`, the live mode and `K_id`, never from `rec.contentKey`, which stays the OPFS key. So a record that crosses the mode change goes to the right path with no re-keying. The resolver's local lookup also tries the raw name, so pre-conversion bytes in the local byte store keep rendering without a download.
  - **A device that already copied ciphertext** into `blocks` (an old build that ran across the conversion) isn't repaired in place, because that would flood `row_events`. It gets the gated reset ([§8](#8-runbook)).
- **#1300 — the upload classifier treats `25006` (read-only database, e.g. a full disk) as transient**, so a full disk doesn't quarantine everyone's edits.

### 6.3 The flow

The flow is one guarded, in-app flow on the converting device (#1290). It reads **the server directly**: the `workspaces` row for its phase, and PostgREST pages of `blocks` and `blocks_history` for its data. It never reads this device's PowerSync image, which stops advancing while any write for the workspace is held ([§6.2](#62-client-prerequisites)). The phase is read on every run, so a reload or crash resumes from what the server shows:

| Server shows | Phase |
|---|---|
| mode `none` | preflight → key → flip |
| phase `sealing` | recovery bundle (unless this device holds a verified one) → re-seal → verify → purge |
| phase `cleaning` | pin upgrade → attachments → `finish_conversion`. Every step is idempotent, and the phase re-runs in full each time |
| mode `e2ee`, no conversion row | nothing left to do, apart from the standalone attachment cleanup (step 8) |

The phase only moves forward, so a resume never falls back.

**Every run**, resumed ones included, holds a `navigator.locks` lock per (user, workspace) and re-confirms the single-client contract ([§3](#3-the-single-client-contract)). Once the mode is e2ee, it also opens the server canary with this device's stored key before sealing anything. If this device holds no key, it asks for the saved one.

**0. Preflight.** It refuses unless all of these hold:
- the user owns the workspace, and it's plaintext. This is an early-out; the flip re-checks both;
- no row already passes the re-seal's "sealed" test (all three content columns envelope-shaped). A plaintext workspace can't hold such a row legitimately, and after the flip it would be indistinguishable from a sealed one;
- the upload queue is drained, attachment records included, and no rejected rows are pending;
- `canPersistPins()` passes, and the key store is durable (not `createWorkspaceKeyStore`'s in-memory fallback);
- the File System Access API is available (desktop Chromium), because the bundle is a folder written through its directory picker and re-opened to verify it;
- the user has dealt with any **oversized object**: one whose sealed size, its bytes plus `BINARY_ENVELOPE_OVERHEAD_BYTES` (36), exceeds 50 MiB, the attachments bucket's original limit. Preflight checks each media block's verified bytes, soft-deleted ones included, and each raw Storage object, orphans included. It measures the bytes, not `media:size`, which is cosmetic.
  - **Why:** a plaintext capture can reach exactly 50 MiB (`DEFAULT_MAX_CAPTURE_BYTES`), and sealing adds 36 bytes. e2ee captures already count the overhead, so only pre-conversion plaintext can fall in that window.
  - **The remedy** is a settings change, not a data change: raise the hosted project's upload limits to at least the largest sealed size preflight reports. That's the project-wide Storage limit, and the attachments bucket's own limit (50 MiB + 64 after #1294's migration) if it's lower. A plaintext capture never needs more than the bucket already allows, but an orphan uploaded outside the app can. The object then seals like any other. The flow lists such objects with their sealed sizes and the remedy, and continues once the user confirms the limits are raised. This is the one point where the conversion itself waits on an operator. Raising the limits ahead of time wouldn't rule it out: the app's own capture cap doesn't move with them, and an upload from outside the app can land within 36 bytes of any limit.
  - **Nothing is discarded** if that confirmation is wrong. The cleaner deletes a raw object only after its keyed copy is uploaded and verified, so a refused upload leaves it in place and the proof waits (step 8);
- the user confirms the residue named in [§7](#7-what-stays-visible-afterwards), disk headroom ([§8](#8-runbook)), free space for the bundle, and any media block with no **hash-verified** source: no local copy, and no raw object whose bytes hash to the block's content hash. Storage objects are untrusted, so a remote-only object is downloaded and checked here, then **kept in this device's byte store**. Step 3 takes it from there, so an object that's deleted or replaced on the server after preflight can't break the bundle after the flip. Disk headroom counts these bytes. No step after the flip can bring those back. Its size is shown: the database, the attachment bytes, the server history and `blocks.jsonl`. A dry run of step 3's paging measures the last two without writing anything. A bundle that can't be written after the flip leaves every device waiting until it is.

**1. Key.**
- If this device already holds a key record for the workspace, from an earlier attempt that didn't flip, the run reuses it. The user saved that key, and a late-committing flip would carry its canary.
- Otherwise, a new key is minted: generated, imported, `K_id` derived, the canary minted, then the **displayed** string re-parsed and checked against the canary. It is revealed once, retyped by the user, and stored durably after a probe write.

**2. Flip.** `convert_workspace_to_e2ee(ws, canary)`. No row changes, and every earlier write has committed. A lock-not-available refusal is retried with backoff, while the flow shows that it's waiting for the database. This device keeps its plaintext pin, so #1293's gate closes the workspace here too: it shows the flow, and holds any write made for the workspace until the purge is done.

**3. Recovery bundle.** One **folder**, taken right after the flip. The flip changes no row, so the bundle still holds the pre-conversion content. And since every earlier write committed before the flip, nothing but the re-seal can add history after its snapshot ([§6.1](#61-server)).
- **Writing it** goes through the directory picker (`showDirectoryPicker`), one file per part, with the database copied under its lock. It isn't a zip:
  - the repository's only zip writer, `fflate`, writes no ZIP64, so it can't address an archive past 4 GiB;
  - the existing verifier refuses one past 4 GiB (`src/utils/exportSqliteDb.ts`);
  - a large workspace's database plus its attachments can exceed that.

  A folder also makes duplicate paths impossible. The user can archive it themselves afterwards.
- **`blocks.jsonl`.** Every block row of the workspace, soft-deleted ones included, read from the server: PostgREST pages by id, every column verbatim, except that **a row the re-seal counts as sealed takes its content columns from its re-seal record** instead: the `before_diff` of its latest plaintext-to-envelope history row, the same record verify uses (step 5). After the flip, only the re-seal moves a row from plaintext to envelopes, so the latest such row is the re-seal's even if the row's history holds an older envelope-shaped write. The "sealed" test is the re-seal's own, all three columns envelope-shaped, which preflight guarantees no plaintext row meets. A sealed row with no record stops the bundle. So the file is always plaintext, and taking it never needs the key: until the purge, the server alone can rebuild it. It's what key-loss recovery restores from ([§8](#8-runbook)). Reading the server rather than this device's database means no download gap or reconnect window can make it stale.
  - **It's a consistent snapshot** only if the workspace's history count is the same before and after the paging, since every write to `blocks` adds a history row. Otherwise it's re-read. Right after the flip nothing else writes, so the first read passes.
  - **Its row count is recorded.** The workspace's block count is read inside that same window and goes in the manifest. Key-loss recovery tombstones every row the file lacks, so a truncated file must never verify.
- **`local.db`.** The raw SQLite export, for the device-local history (`row_events`, `command_events`). It isn't a restore source.
- **`server-history.jsonl`.** The workspace's `blocks_history`, which members can read under RLS (`blocks_history_read`).
  1. Read `through` = `coalesce(max(event_id), 0)`.
  2. Page by `event_id` (`> cursor`, `≤ through`, ordered), never by offset.
  3. Stream one row per line, with every column verbatim, `workspace_id` included.
- **`attachments/<hex digest>`.** Exactly one entry per media block content hash, soft-deleted blocks included. Each entry is plaintext whose sha256 is that hash, taken from the local byte store or the raw Storage object, whichever verifies. One file per hash, named by the bare lowercase hex digest. The stored hash is `sha256:<hex>` (`src/sync/crypto/contentHash.ts`), and `:` isn't allowed in Windows filenames.
- **`other-objects/<hex sha256 of the object path>`.** Every other object in the workspace's Storage listing, byte for byte, so the cleaner may later delete it. A Storage path can hold characters, `/` nesting or a length that no filesystem accepts as one name. A digest of the path gives a 64-character name that every filesystem takes. The manifest maps each name back to its original path.
- **`manifest.json`.** The workspace id, `through`, the line count of each `.jsonl` part, the server's block count, the content hashes the user confirmed in preflight as having no verified source, a sha256 of each part, and the export time.

The flow **re-opens the folder and verifies it**: the hashes match; `blocks.jsonl` has exactly the server's block count of lines, with no id repeated; every row of `blocks.jsonl` carries the manifest's workspace id, which is the workspace being converted; every media block in it, soft-deleted ones included, has its `attachments/` entry, and the entry's bytes hash to the digest in its name, unless the manifest lists its hash as having no verified source, and that list holds nothing else; and every `server-history.jsonl` row carries the manifest's workspace id, with `event_id`s that strictly increase and end at `through`, or the file is empty and `through` is `0`. A workspace whose rows predate the history trigger can have no history at all. It then keeps `through`, the line counts, the original Storage paths archived under `other-objects/`, and the sha256 of the verified `manifest.json` on this device as the **bundle record**. The manifest's hash pins every part's hash, so a different folder with matching counts can't pass step 6. The re-seal never starts without that record. It's cleared once the conversion finishes; the attachment cleaner needs it after the purge.

The bundle is plaintext, as sensitive as the database. Store it on an encrypted volume, or archive it first if it's going into a password manager. It isn't sealed under the workspace key, because then it would be unreadable exactly when it's needed: after the key is lost. **It's a point-in-time content snapshot, not a rollback.** There's no going back after the flip.

**4. Re-seal** (#1292). Page through the workspace's rows on the server by id, soft-deleted ones included, and skip rows that are already sealed. For each page:
1. **Seal** the three content columns under the existing envelope and AAD (`encodeForWire`).
2. **Open every column** under the key before sending. This fails fast on a key or AAD bug, before a multi-hour pass.
3. **Send** through the existing `apply_block_patches` RPC, called **directly** (SECURITY INVOKER, granted to `authenticated`): one `{id, content, properties_json, references_json, base_updated_at}` per row, with the base taken from the row just read.

Resuming just runs this again. It can take hours for a large workspace, so the flow keeps a progress view and a wake lock.

**5. Verify.** Each row's **record** is its re-seal write: its latest history row whose content columns go from plaintext in `before_diff` to envelopes in `after_diff` that open under the workspace key. Both conditions exclude an older pre-conversion write that only looked sealed. The record is identified by its content, not by its position, so a re-taken bundle doesn't move it, and it stays durable on the server until the purge.
- **The check.** Page that history as the export does. Decrypt each current server row, and require every content column to equal the record's `before_diff` value.
- **A mismatch** is re-sent from that value and checked again. This catches a wrong value that still opens, such as another row's value.
- **A row with no record refuses the run.** Something other than the re-seal sealed it.
- **The other columns** need no check here, because the purge refuses any write after `through` that touched more than the content columns and `updated_at`.

**6. Purge.**
1. **Re-verify the bundle first.** Re-open the saved folder, through the stored directory handle or by asking the user to pick it, and check that its manifest hashes to the one in the bundle record, names this workspace, and every part matches it. The re-seal can take hours, and the folder may have been moved or changed meanwhile.
   - If it can't be read, or doesn't match, the purge doesn't run.
   - The record is cleared, and the next run re-takes the bundle. History is still on the server, and `blocks.jsonl` takes rows already sealed from their re-seal records, so the new bundle is as complete as the first.
2. **Then purge:** `purge_workspace_history(ws, through, count)`, from the bundle record. The server re-checks all four conditions ([§6.1](#61-server)).
   - **`KMC01`, a row isn't sealed.** The record stays: the next run re-seals what's left, verifies and tries again.
   - **`KMC02`, the bundle is stale.** Something outside the re-seal wrote history, such as a hard delete by an operator or another client. The flow says so, clears the record, re-takes the bundle so that history is archived too, and tries again.
   - Nothing is lost either way. A refusal that keeps coming back is for investigation.
   - **A transport error** retries.

**7. Pin upgrade on this device** (#1293). Every row is drained into `blocks`, decrypted. Each update is version-only, so #1299 keeps `row_events` clean. Held writes now upload, sealed.

**8. Attachments** (#1291). One cleaner, on this device, using the member client's Storage API. The owner can also run it on its own on any e2ee workspace, as **Clean up attachments**, for a raw object an older client uploads later. It's the same idempotent pass, whether a conversion row exists or not.

- **One classification rule, by content**, written once next to `deriveContentKey`. For bytes `b` under name `n`:
  - **raw** iff `n == hex(sha256(b))`;
  - **keyed** iff `n == hex(HMAC(K_id, h))` for a hash `h` the pass already knows, and `b` opens under the workspace key to a `p` with `sha256(p) == h`. The asset AAD binds the content hash (`assetBytesAad`), so an envelope can only be opened under a candidate hash. The candidates are every media block's hash, soft-deleted ones included, plus the hash of each raw object this pass converts. A keyed object under any other hash, such as a converted orphan's copy on a later pass, is **neither**: it's kept and reported, never deleted, because the bundle record names only original paths;
  - otherwise **neither**.

  Both kinds of name are 64 hex characters, so the rule never reads a header or the name's shape. As a fast path, a name equal to the keyed name of any media block's hash, soft-deleted ones included, is kept without a download. The fast path only decides "don't delete"; the proof still verifies the object.
- **One verification helper**, shared with the resolver, the upload drain and upload recovery.
- **Repeat until a complete listing needs no action:**
  1. List `<ws>/` **completely before acting**: one flat listing of every object's full name, nested ones included, compared bytewise. Storage's v1 `list()` matches folder names case-insensitively, so it can merge `Dir/` and `dir/`; the adapter uses `listV2` with no delimiter.
  2. **Raw:** seal it, upload it to its keyed name, verify the upload, then delete the raw object. A 409 on an occupied keyed path goes through the same check. If the occupant fails it, the occupant is a poisoned or wrong-key copy of bytes this pass holds verified, so delete it and upload again. The Storage policy allows exactly that delete, for poison correction. **A refused upload**, such as a 413 for an oversized object (step 0), leaves the raw object in place. The pass reports it with the remedy and goes on.
  3. **Keyed:** keep it.
  4. **Neither:** if the bundle archived it under `other-objects/`, re-read that entry immediately before the delete, and delete the object only if the entry matches its bytes. The bundle record alone isn't enough, because the folder can be moved or changed after it was verified. Otherwise, or if the entry can't be read, leave the object and report it; it never stops the pass, so every raw object is still reached. A standalone run has no bundle record, so it converts raw objects and only reports the rest, such as objects kept from an old key after a key-loss recovery.
- **The proof:**
  - no raw object remains, and no object the bundle archived under `other-objects/`. Either one holds back `finish_conversion` until its cause is fixed and the pass re-runs: a refused upload's limits (step 0), or a bundle folder that can't be read, which the flow asks the user to pick again. If the bundle is lost for good, the conversion stays in `cleaning` with those objects reported as residue, because deleting them without a copy is never the answer;
  - every media block's keyed object, soft-deleted blocks included, is present **and** passes the shared verification helper (downloaded, opened, hash-checked). That costs one download of the attachment set, because Storage objects are untrusted.

  A missing or failing object is rebuilt from the bundle's bytes or the local ones. When neither has them and there's no raw object, the failing object at the block's keyed name is all that's left:
  - **If it holds the block's own plaintext,** it's that block's only copy. It's first copied to its raw name and read back verified, then converted from there like any raw object.
  - **Otherwise** the block's bytes exist nowhere and it can't be rebuilt. The object is a **neither** object the bundle never archived, so it's kept and reported (step 4 above): deleting it without a copy could lose bytes someone else can still open.

  So the proof's result is **passed, with these blocks unrecoverable**. The flow lists them together with every object the pass kept and reported, and `finish_conversion` follows the user's confirmation, so nothing left behind is silent. Preflight already lists the same blocks before the flip (step 0).
- **Media block ids don't change.** The app derives an attachment's path from `media:hash`, the mode and `K_id`. Re-capturing a pre-conversion file mints a second block, which is accepted.

**9. Done.** The flow calls `finish_conversion`, then tells the user to open each other device with the key and to keep the bundle with it. The rest, [§8](#8-runbook)'s **After** steps and the "safe from" date they set ([§9.4](#94-the-safe-from-rule)), belongs to this runbook, not to the app.

### 6.4 Other devices

Once the phase leaves `sealing`, each device that opens the workspace sees the mismatch (#1293). It defers, prompts for the key, upgrades its pin one way, and drains. Its local `row_events` survive, and #1299 keeps the drain from adding noise to them.

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
   - **every** device runs a build that includes #1293. #1299 and #1300 merge before #1293, so such a build has them too. Boot reinstalls whichever local triggers the running build defines, so what matters is the build each device runs, not when it last updated;
   - #1294's migration is applied. The upload limits can stay as they are, unless preflight lists an oversized object (step 0);
   - #719 has shipped, so new `[[links]]` stop minting public ids;
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
7. **Convert before the properties-as-blocks switch** (the owner's call, 2026-10-20). Converting first keys the ids of definitions synthesized at the switch under `K_id`. Switching first would leave them name-derived ([§7](#7-what-stays-visible-afterwards)). The two must never overlap, so the switch waits until `finish_conversion` has run.
8. **Rehearse** the conversion on a scratch workspace first. The record is under **Rehearsal of 2026-10-20**, below the checklist. Run it again after a change to the flow, to the conversion's server functions, or to the hosted Postgres or PostgREST version.
9. Run from desktop Chromium, on the device that holds the most attachment bytes locally.

**Run-day checklist.** In order. Each item names the step above that owns it.

a. **Settled beforehand:**
   - the deploys (step 1);
   - the ordering against the properties-as-blocks switch (step 7). Neither preflight nor the flip checks it, so confirm the switch hasn't started on this workspace and won't run during the conversion;
   - disk headroom (step 6);
   - the key's two places (step 4), and an encrypted volume with room for the bundle;
   - the name (step 5).

b. **Fleet** (step 3). Drain every queue, then close every other tab and device: PWA windows, other browser profiles, phones and tablets, and any agent-bridge tab.

c. **Fresh statistics.** The operator runs `ANALYZE public.blocks_history;`.
   - Name the table. A bare `ANALYZE` also locks `blocks`, and the flip would have to wait.
   - It blocks no reads or writes. It does wait behind an autovacuum of the table.
   - Why: preflight and the bundle page through the workspace's history, and with stale statistics each page costs the rest of it (the rehearsal, below).
   - Run operator SQL as `postgres` over a direct connection, such as psql. The Dashboard's SQL editor caps queries at 60 s.

d. **Predict the purge.** It deletes the history plus one re-seal row per block. The rehearsal ran at about 9.4 s per 100k of those rows together, and preflight's confirmation shows both counts.
   - The limit that matters is the function's own 5 minutes, about 3 million of those rows at that rate.
   - Past about 125 s the API gateway answers 504, but the delete runs on and commits. The flow's retry then finds the phase moved to `cleaning`, and carries on. *(measured with a probe, below)*
   - If the prediction nears 5 minutes, raise the function's timeout first, or plan on the direct-connection purge in (g).

e. **Start.** On the profile from step 9: workspace settings → **Encrypt this workspace…**.
   - Note how long preflight takes. Its history scan is the same read the bundle makes after the flip, so it predicts the bundle.
   - If preflight runs for minutes, close the flow at its confirmation, where nothing has changed yet. Repeat (c), then start again.

f. **Keep the tab in front** and the machine awake until the flow says it's done.

g. **If a step times out:**
   - **A history read before the flip:** preflight stops. Repeat (c) and start again.
   - **A history read after the flip:** **Try again** carries on from the server's phase.
     - With no verified bundle recorded, it takes the bundle again.
     - Otherwise it repeats the re-seal pass and verify before the purge.
     - Every device holds its writes for this workspace until the purge passes. The flow has no remedy beyond (c).
   - **The purge:** the flow makes 4 attempts on its own before it shows the error, and each attempt is a whole delete, rolled back. Then do one of these:
     - **Raise the function's timeout**, if that was the limit hit, then **Try again**:
       - run `alter function public.purge_workspace_history(text, bigint, bigint) set statement_timeout = '15min';`;
       - PostgREST picks the change up when it reloads its schema; `notify pgrst, 'reload schema';` forces that;
       - set it back to `'5min'` afterwards.
     - **Run the purge over a direct connection as `postgres`**, then **Try again**. The flow reads `cleaning` and carries on.
       ```sql
       begin;
       set local statement_timeout = '30min';
       select set_config('request.jwt.claims', json_build_object('sub', '<owner user id>', 'role', 'authenticated')::text, true);
       select public.purge_workspace_history('<workspace id>', <through>, <archived count>);
       commit;
       ```
       `<through>` is the bundle's `manifest.json` `through`. `<archived count>` is its `parts["server-history.jsonl"].lines`.

h. Then the **After** steps, in order.

**Rehearsal of 2026-10-20.**

**Setup.**
- **Where:** the hosted project, on Postgres 17.11 and PostgREST 14.18. Desktop Chrome, on the production build `8858f449`.
- **Workspace:** a synthetic scratch workspace of 50,281 blocks, 7% of them soft-deleted. It also had 66,415 history rows and 12 attachments totalling 12 MB.
- **Result:** it passed end to end, and a second browser unlocked the workspace with the key.
- **Not covered here, but in the second rehearsal below:** a device whose local copy survived the flip, and Stop and resume. Neither rehearsal covered the **After** steps.

Times measured, and per 100k rows where that scales:

| Phase | Measured | Per 100k blocks | Per 100k history rows |
|---|---|---|---|
| Preflight: blocks | 15 s | 30 s | |
| Preflight: history, on the slow plan | 2 min 3 s | | doesn't scale: grows with the square of the history |
| Flip | 11 ms on the server | | |
| Bundle: this device's database | 11 s | | grows with that database |
| Bundle: history, on the slow plan | 2 min 0 s | | doesn't scale |
| Bundle: blocks | 12 s | 24 s | |
| Bundle: attachments, then its check | 15 s, 7 s | | grows with attachment bytes |
| Re-seal | 2 min 53 s | 5.7 min | |
| Verify | 3 min 49 s | 7.6 min | |
| Purge: 66,415 history rows plus 50,281 re-seal rows | 11.0 s on the server | | 9.4 s, of the two together |
| Pin upgrade | 58 s | 1.9 min | |
| Attachments: 12 objects | 46 s | | grows with attachment bytes |

**What it showed:**
- **The hosted PostgREST applies a function's own `statement_timeout`.** The purge ran 11 s, past `authenticated`'s 8 s limit, and succeeded. *(measured)*
- **History reads depend on the planner's statistics.**
  - **What happened.** The scratch history had been written after the table's last `ANALYZE`, and its pages never used the `(workspace_id, event_id)` index. The cost of a page fell as the cursor advanced: the read ran at 327 rows/s at the start and 1,645 rows/s at the end, and its slowest page took 1.85 s with about 66k rows still ahead. *(measured)*
  - **With current statistics,** the planner picks that index, and a page of 500 took 26–78 ms on the server. *(measured on a smaller workspace)*
  - **Why it matters at scale.** The slow plan reads every row still ahead of the page. From about 290k rows ahead, a page passes the 8 s limit, and halving the page size doesn't help. Hence (c). *(inferred)*
- **Re-seal and verify set the run's length:** about 13 minutes per 100k blocks between them. That holds at the rehearsal's ratio of about 1.3 history rows per block; a history much larger than its blocks shifts the weight to the two history reads.
- **A device whose local copy was gone** showed only "Loading workspace…" for 2.3 minutes while it downloaded 50k sealed rows, then asked for the key. *(measured)*

**Second rehearsal, the same day.**

**Setup.**
- **Workspace:** a scratch workspace of 10,167 blocks (763 soft-deleted), 13,964 history rows and 4 attachments.
- **Devices:** it was written from one Chrome profile, which kept its full plaintext copy and was closed for the run. The conversion ran from a second profile, with the checklist's `ANALYZE` just before the flip.

**What it showed:**
- **Preflight took 7 s,** and its history pages used the `(workspace_id, event_id)` index. This history, too, was newer than the table's last `ANALYZE`, so stale statistics alone don't bring on the first rehearsal's slow plan. What does is still unexplained. *(measured)*
  - The bundle wrote its history at about 3,000 rows/s, against 360 rows/s on the slow plan.
- **Stop during the re-seal, then continue.**
  - Stop took effect at 6,800 of 10,167 rows, with the phase still `sealing`.
  - The next run reused the recorded bundle and this device's key, skipped the sealed rows, and finished.
- **The rest of the run.** Verify ran at 330 rows/s. The purge took 2.0 s on the server for 24,131 rows, the pin upgrade 8 s, and the attachments 9 s.
- **The device with an intact copy, reopened after the finish:**
  - it went straight to the key prompt, within 3 s of loading;
  - it showed no old view, and queued no writes;
  - after the key, it applied the re-sealed rows as version-only updates: its row versions matched the server's, and its local change log grew by its own 11 new writes, not by 10k (#1299). *(measured)*
- **The bundle folder, checked outside the app:**
  - every part matches its manifest digest;
  - `blocks.jsonl` holds 10,167 unique plaintext rows, the soft-deleted ones included, and agrees with `local.db` on every row's content columns and deleted flag;
  - the history is strictly increasing and ends at `through`;
  - each attachment hashes to its name;
  - `local.db` passes `integrity_check`. *(measured)*
- **The API gateway cuts a request at about 125 s.**
  - A probe function that sleeps returned normally at 75 s, and answered `504 upstream request timeout` at 125 s for 150 s.
  - Its statement ran to the end.
  - A probe that changes its own comment after sleeping 140 s did commit. *(measured; both probes dropped)*

**After:**

10. **PowerSync Defragment, then the other devices.**
    - In the PowerSync Dashboard, open the instance's **Settings**. Under "Compact operation history", run **Defragment** ([§9.3](#93-powersync) says why).
    - Deploy no sync config until it's done, because a deploy stops the stream it's building.
    - Every client of every user on the instance downloads all its data again. Running it before the other devices open means each of them downloads once. That only saves bandwidth; nothing else depends on it.
    - **It's done when the instance logs show the new stream active and the old one terminated** ("Successfully terminated replication stream").
      - The hourly Supabase Health probe fails `replication_slots` while two slots exist.
      - Its slot count is no proof on its own: a Defragment that fails also ends with one slot, the old one.
    - Then open the other devices one at a time, and paste the key on each.
      - **A device whose local copy is gone** shows only "Loading workspace…" until it has downloaded everything: about 4.6 minutes per 100k rows in the rehearsal.
      - **A device whose copy is intact** goes straight to the key prompt, and applies the re-sealed rows once unlocked (the second rehearsal).
      - **A device left open during the run** can have writes the server refused ([§3](#3-the-single-client-contract)). Once it's unlocked, open **Rejected sync changes** and press **Retry** on each.
      - Either way, don't clear site data (step 2).
    - Once every device is back, the owner runs **Clean up attachments** ([§3](#3-the-single-client-contract)). Its report must list no object left in place; investigate any it does before going on.
11. **Operator: `VACUUM FULL`** on five tables: `blocks`, `blocks_history`, `storage.objects` and `workspaces`, then `pg_catalog.pg_statistic`.
    - It takes ACCESS EXCLUSIVE locks, which block reads **and** writes on each table for a time proportional to the table's **total** size across all workspaces. Schedule it.
    - Set a `lock_timeout` of a few seconds, and retry on a timeout. A lock request that waits queues every tenant behind it, which is also why the flip uses `NOWAIT` ([§6.1](#61-server)).
    - Run it after the Defragment, whose snapshot would otherwise hold it off.
    - **Run them one at a time.**
      - On the first four, run `VACUUM (FULL, ANALYZE, VERBOSE)`. The `ANALYZE` replaces the planner's sampled values, which still hold plaintext ([§9.1](#91-supabase-postgres)).
      - Then `VACUUM (FULL, VERBOSE) pg_catalog.pg_statistic` drops the old samples.
    - **Check each of the five:**
      - **The output reports `0 dead row versions cannot be removed yet`.** A transaction older than the purge keeps alive the dead rows it can still see, and `VACUUM FULL` copies them into the new table. End that transaction, then run it again.
      - **`pg_relation_filenode()` changed.** A table the role can't vacuum is skipped with a WARNING, not an error, and keeps its filenode. `postgres` owns the database, which lets it vacuum all five ([§9.1](#91-supabase-postgres)).
    - Record when it finished, privately ([§9.4](#94-the-safe-from-rule)). The "safe from" date counts from that time.
    - While it runs, the health probe fails `postgrest`, which reads `blocks`, and may fail `pgsql_tmp`.
    - `pg_repack`, if available, is the non-blocking alternative to the rewrite; the `ANALYZE` and the `pg_statistic` step still apply.
    - This step and the next, and step 10's Defragment, are platform operations a client can't do.
12. **Operator:** drop leftover ad-hoc tables from past scripts (`scripts/system-author-cleanup.sql`, `scripts/roam-ts-backfill/backfill.sql`).
13. **Record the "safe from" date** privately: the date that [§9.4](#94-the-safe-from-rule) sets from step 11's finish time. It stays provisional while any [§9.5](#95-open-items) item marked *gates the date* is open.
14. **Take later recovery points.** From time to time, on an unlocked device, take a recovery point and keep it with the key. The gesture that takes one is part of #1302's build. Until it ships, the conversion's bundle is the only recovery point, so a lost key would bring the workspace back to its state at the conversion. It's a folder, like step 3's, with:
    - `blocks.jsonl`: every block row read from the server, checked for consistency and against the server's block count exactly as in step 3. History has been purged by then, so each row's content columns are opened under the key. A write from any device during the paging, this one included, makes it re-read. Taking it while other devices are idle keeps that rare;
    - **the plaintext of every media block**, soft-deleted ones included. Each comes from whichever source verifies: the local byte store, the keyed object downloaded and opened under the key, a raw object whose bytes hash to its name (a late upload from an older client), or an earlier recovery point (the conversion's bundle included). Each is hash-checked. The manifest lists only the hashes that no source verifies **now**, so a block that had no bytes at the conversion but was re-captured since is included again;
    - a manifest.

    It leaves out the server history and the Storage objects themselves, which are ciphertext by then and useless once the key is lost. A raw SQLite export isn't a recovery point. It holds only what this device has downloaded and applied, and attachment bytes live outside it (`src/plugins/attachments/byteStore.ts`).

**Key-loss recovery** (#1302) **isn't a prerequisite for the first run** (the owner's call, 2026-10-20). What protects the workspace is the key saved in two places, from before the flip, and the plaintext bundle, from right after it. Until the purge, the server alone can rebuild that bundle without the key (step 3), so the window between the flip and the bundle loses nothing either. The restore can be built when a key is actually lost, and nothing is lost while it doesn't exist. Until then, a lost key leaves the workspace unreadable until recovery is built, and it comes back at the newest recovery point.

No device needs #1302's build before a recovery runs either, lost ones included. Once a workspace is re-keyed, #1302's server fence refuses every write without the current key-generation stamp, which covers every write from an older build (#1316 §3.2). Such a device's writes go to the rejection quarantine instead of landing over the restore. Upgrading a device only lets it keep writing.

Before the purge, nothing is lost, but a key lost during `sealing` still needs a way forward:
- **Before the first re-sealed row,** no row is sealed. Re-key, take the bundle if it wasn't taken yet, and carry on.
- **After it,** the conversion's bundle is a complete plaintext copy of every row, because nothing but the re-seal writes during `sealing`. If it's lost too, re-take it: step 3 needs no key before the purge. Recovery then runs exactly as below, from that bundle. Its equality check stands in for verify, and then the conversion's purge runs as usual, with `through` and the counts taken from the bundle's own verified manifest.

So the re-key RPC is admitted during `sealing` too.

After the purge, recovery **re-keys the workspace in place** from the newest recovery point: a step-14 one, or the conversion's bundle. A device that still defers is no source: its `blocks` hold nothing the conversion's bundle lacks. **It's point-in-time, not lossless.** Everything written after that point is lost, because nothing else holds that plaintext. That's why the key lives in two places, and why step 14 exists.

**#1302 holds recovery's requirements, and #1316 is its design.** Its bead is their single home; this doc doesn't repeat them. What the conversion owes it, all specified above:
- a bundle that needs no key before the purge, so a key lost during `sealing` is recoverable even without the saved bundle (step 3);
- a re-key that the server admits during `sealing` as well as after it, with the flip's lock order;
- recovery points that are complete, bound to this workspace, and verified (step 14);
- nothing from the fleet: #1302's server fence refuses an un-upgraded device's writes, so the conversion's deploy gate doesn't include #1302's client half.

## 9. Platform residue, and when it is "safe if breached"

#1289 answered these on 2026-10-19 for the hosted project. Each answer ends with what it rests on:
- *(measured)*: read from this project on 2026-10-19 with the Supabase CLI: its Management API reads (`backups list`, `services`, `postgres-config get`), and read-only `db query --linked`;
- *(read: …)*: stated by a primary source, the vendor's docs or its code at the version linked;
- *(inferred)*: reasoned, from what the label or the bullet names.

### 9.1 Supabase Postgres

**Backups.**
- The project takes a physical backup every day at about 14:14 UTC, plus off-schedule ones, such as one on 2026-10-17 around a hosted Postgres upgrade, and lists the last 7 days of them. PITR is off: on 2026-10-19 the listing showed `pitr_enabled: false` and `walg_enabled: true`. *(measured)*
- Retention is the plan's: 7 days on Pro, 14 on Team, up to 30 on Enterprise. *(read: [Backups](https://supabase.com/docs/guides/platform/backups))* The project is on Pro, which matches the 7-day listing. *(measured: the owner, in the dashboard, 2026-10-20)*
- **A physical backup snapshots the database's directory,** dead tuples included. So every backup that started before `VACUUM FULL` finished holds plaintext. *(read: same page; inferred: how a file-level copy works)*
- **WAL is archived even with PITR off:** `archive_mode = on`, with `archive_timeout = 120`. *(measured)*
  - The conversion's WAL carries the re-seal's history rows, whose `before_diff` is plaintext. *(inferred)*
  - How long that archive is kept with PITR off isn't documented ([§9.5](#95-open-items) S1).
- **Enabling PITR stops the daily backups,** and keeps WAL for the retention period chosen: 7, 14 or 28 days. *(read: same page)* So PITR stays off until the "safe from" date, or its retention is added to it.
- **Whether a backup that leaves the listing is deleted** isn't documented ([§9.5](#95-open-items) S2).

**Logs.**
- API and database logs are kept 1 day on Free, 7 on Pro, 28 on Team and 90 on Enterprise. *(read: the [pricing](https://supabase.com/pricing) table, `packages/shared-data/pricing.ts` in supabase/supabase)*
- **The hosted logging settings** *(measured)*. They match Supabase's template ([`postgresql.conf.j2`](https://github.com/supabase/postgres/blob/6939f8696270341c67822113aac64987171d1cb6/ansible/files/postgresql_config/postgresql.conf.j2)):
  - `log_statement = 'ddl'`;
  - `log_min_duration_statement = -1`;
  - `log_parameter_max_length_on_error = 0`, so an error logs no bind values;
  - `pgaudit.log = none`.

  `postgres-config get` shows no project-level override. No role or database override touches logging, apart from `log_statement = none` for Supabase's own service roles.
- **An error's `DETAIL` can print the failing row.** A `NOT NULL` violation on `blocks` prints the whole row, content included. *(inferred: Postgres's error format)*
- **`auto_explain` logs any top-level statement over 10 s with its bind values in full.** *(measured: `auto_explain.log_min_duration = 10000`, `auto_explain.log_parameter_max_length = -1`)*
  - App traffic never reaches that. `authenticated` and `authenticator` time out at 8 s *(measured)*, and `auto_explain` logs only a statement that finishes *(inferred: it logs at executor end)*.
  - The only functions that raise their own timeout, `purge_workspace_history` and `delete_workspace`, take ids and counts *(read: `supabase/migrations/`)*.
  - An operator's slow query as `postgres`, which has no timeout, would be logged with its values.
- **So an app statement's text and parameters stay out of the logs.** Only an error's `DETAIL` can carry content.
  - Every content write is an RPC call (`apply_block_patches`, `apply_block_creates`), and every read filters by id or workspace id. *(read: `src/services/powersync.ts`, `src/sync/conversion/conversionServer.ts`)*
  - PostgREST passes an RPC's arguments as a bind parameter, so an error's logged `STATEMENT` holds none of them. *(inferred: PostgREST's prepared statements)*
  - That holds only while the settings above do. Logging every statement (`log_statement = 'all'`), or logging by duration, would log an RPC's bind values in full, because `log_parameter_max_length` is unlimited. *(read: [error reporting and logging](https://www.postgresql.org/docs/17/runtime-config-logging.html))*
- **API logs** have no documented request-body field, so bodies aren't kept *(inferred)*. The app sends content only in RPC bodies, and its URLs carry only ids *(read: same files)*.
- **Log Drains** copy logs out, on Pro and up, with the destination's retention. *(read: [Log Drains](https://supabase.com/docs/guides/observability/log-drains))* This project has none. *(measured: the owner, in the dashboard, 2026-10-20)* Adding one before the "safe from" date would add its retention.

**Elsewhere on the server.**
- **Planner statistics hold sampled values.**
  - `pg_statistic` keeps each analyzed column's most common values and histogram bounds. *(read: [`pg_stats`](https://www.postgresql.org/docs/17/view-pg-stats.html))*
  - Those include values of `blocks.content`, `properties_json`, `references_json`, `blocks_history`'s diffs and `workspaces.name`. *(inferred)*
  - `VACUUM FULL` doesn't refresh them; only `ANALYZE` does. *(read: [`VACUUM`](https://www.postgresql.org/docs/17/sql-vacuum.html))*
  - The old samples stay as dead tuples in `pg_statistic` until that table is vacuumed. Runbook step 11 does both.
  - `postgres` may vacuum it. It isn't a superuser, holds no MAINTAIN privilege on `pg_statistic`, and isn't in `pg_maintain`, but it owns the database *(measured)*.
  - Postgres 17 lets a database's owner vacuum any table in it that isn't shared, and `pg_statistic` isn't. *(read: `vacuum_is_permitted_for_relation` in [`vacuum.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/commands/vacuum.c))*
- **The host's own Postgres log file.** It rotates by size, 9 files of 50 MB, not by age. So on a quiet project it holds the log lines above for longer than the plan's log window. It isn't readable through SQL. *(read: `logrotate-postgres-csv.conf` in supabase/postgres at the commit above)*
- **`pg_wal`** keeps the conversion's WAL until it's recycled, and it isn't readable through SQL. *(inferred)*
- None of these hold plaintext:
  - `pg_stat_statements` stores normalized statements. *(read: upstream Postgres)*
  - This repo uses no `pg_net`, and its migrations publish none of its tables to Realtime. *(read: `supabase/migrations/`)*
  - The hourly health probe prints only aggregates and hashed ids into its public Actions log. *(read: `scripts/supabase-health.mjs`)*

### 9.2 Supabase Storage

- **A delete has no trash.** The docs say deleted files are "permanently removed and not recoverable". *(read: [Delete objects](https://supabase.com/docs/guides/storage/management/delete-objects))*
- **The two delete routes differ.** *(read: [`src/storage/object.ts`](https://github.com/supabase/storage/blob/v1.80.2/src/storage/object.ts) and [`src/storage/backend/s3/adapter.ts`](https://github.com/supabase/storage/blob/v1.80.2/src/storage/backend/s3/adapter.ts) at v1.80.2, the hosted version `npx supabase services` reported on 2026-10-19)*
  - **The single-object route** (`DELETE /object/<bucket>/<path>`) deletes the S3 object inside the transaction that deletes the row. A backend failure rolls the row back.
  - **The bulk route**, which supabase-js's `remove()` uses, deletes the rows, then sends S3 `DeleteObjects` requests. A request that fails rolls its batch back, but the per-key errors inside a successful response are never read.
  - S3 reports per-key failures inside a successful response *(inferred: S3's `DeleteObjects` contract)*. So a key it failed to delete stays in the backend with no row, invisible to every listing, the cleaner's included.
  - **So the app deletes through the single-object route**, cleaner included *(read: `delete` in `src/plugins/attachments/blobStore.ts`)*.
- **Versioning.**
  - The hosted version has no bucket versioning. Storage `master` adds it, off by default, and nothing here enables it. *(read: v1.80.2 and `master`, this repo's migrations)*
  - Whether the S3 bucket behind Supabase Storage keeps object versions isn't documented ([§9.5](#95-open-items) S3).
- **No overwrite.** The app uploads with `upsert: false`, and the bucket has no UPDATE policy, so an object is never replaced in place. *(read: `src/plugins/attachments/blobStore.ts`, `supabase/migrations/`)*
- **Backups don't hold objects,** only their `storage.objects` rows. *(read: [Backups](https://supabase.com/docs/guides/platform/backups))* Those rows name each raw object `hex(sha256(plaintext))`, a guess oracle but not content, and they follow the database backups' window.
- **CDN.** Smart CDN is on for Pro and up. Deleting an object invalidates every cached entry for it within about a minute. *(read: [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn))* Private-bucket objects are cached per user. *(read: [CDN fundamentals](https://supabase.com/docs/guides/storage/cdn/fundamentals))*

### 9.3 PowerSync

**Residue.**
- **Every replicated change appends an operation to its bucket.** The re-seal's UPDATE appends a ciphertext PUT per row, and the row's old PUT, which holds the plaintext, stays until compaction. *(read: [Compacting buckets](https://docs.powersync.com/maintenance-ops/compacting-buckets))*
- **Compaction** turns a PUT into a MOVE, and clears its data, once a later operation on the same row supersedes it. *(read: the three compactors in powersync-service [`aac9a360b9`](https://github.com/powersync-ja/powersync-service/tree/aac9a360b9ba4df7e1234b2ea2849087a2b9d186), `MongoCompactorV1.ts`, `v3/MongoCompactorV3.ts`, `PostgresCompactor.ts`)*
  - PowerSync Cloud compacts every bucket once a day, and the Dashboard's **Compact** or `powersync compact` runs it on demand. *(read: same docs page)*
  - **One run isn't a guaranteed scrub.**
    - A run tracks the rows it has seen only up to a memory limit, 64 MB by default. A row past that limit keeps its older PUTs. *(read: the compactors)*
    - On storage version 4, a run may only merge newly added chunks. *(read: same docs page)*
    - The limit Cloud's daily run uses isn't documented ([§9.5](#95-open-items) P1).
- **Defragment** rebuilds all sync data from the source database. It's a full reprocess, which creates a new replication stream. *(read: same docs page, [Storage version 4](https://docs.powersync.com/sync/advanced/storage-version-4))*
  - The new stream gets its own Postgres slot, named after it. *(read: `WalStream.ts`)*
  - Once it's active, the old stream is terminated, which drops its slot and clears its storage. *(read: `AbstractReplicator.ts`)*
  - Redeploying the sync config is not the tool for this. The docs say so, and under incremental reprocessing an unchanged stream keeps its history.
- **The service's current-row store** holds each row's latest image, which the re-seal replaces with ciphertext. *(inferred: its role)*
- **Below the bucket API,** nothing is documented ([§9.5](#95-open-items) P2–P4).

**Can compaction or a reprocess yield a checkpoint missing a row? No, by design.** That rests on reading the code, not on a test:
- **Compaction** only rewrites an operation that a later one on the same row supersedes. A CLEAR replaces only a leading run of operations with no PUT among them, and it carries their combined checksum. *(read: the compactors)*
- **A checkpoint in flight.** If compaction rewrites operations of a checkpoint a client is still downloading, the server withholds that checkpoint's `checkpoint_complete`, and a new one follows. *(read: `packages/service-core/src/sync/sync.ts`)*
- **The client** applies nothing until every bucket's checksum matches. On a mismatch, it drops that bucket's local operations and returns without touching any table. *(read: `sync_local` and `delete_buckets` in `crates/core/src/sync/storage_adapter.rs`, powersync-sqlite-core [`feb2fa5b1a`](https://github.com/powersync-ja/powersync-sqlite-core/tree/feb2fa5b1a432bc7189bfc15817e14ee464b129e))*
  - The deletions this queues apply only once the bucket is downloaded again, because until then the emptied bucket fails the checksum check. *(inferred)*
- **A reprocess's new stream** becomes active only once its snapshot is done. It stops the old stream in the same transaction, and until then clients keep syncing from the old one. *(read: the activation step of the MongoDB and Postgres storage batches)*
- **A device that defers** ([§6.2](#62-client-prerequisites)) downloads everything again after a Defragment. Its materialize still defers, and its `blocks` keep their plaintext. *(inferred: §6.2)*

### 9.4 The "safe from" rule

- **Live systems are safe once all of these are done:**
  - `finish_conversion`;
  - the Defragment (runbook step 10);
  - the last **Clean up attachments** run, whose report lists nothing left in place, and a minute after its last delete, for the CDN to drop what it cached ([§9.2](#92-supabase-storage); step 10);
  - the `VACUUM FULL` with `ANALYZE` and the `pg_statistic` rewrite, each checked (step 11).

  A breach of them then exposes only ciphertext and the [§7](#7-what-stays-visible-afterwards) metadata. That holds for SQL, the Storage API and the sync protocol.

  Below those, some residue is accepted:
  - freed disk blocks;
  - recycled WAL segments;
  - the host's log file;
  - what [§9.5](#95-open-items) asks the vendors.
- **Copies that age out are safe from the later of:**
  1. **the first day the oldest backup in `npx supabase backups list` was taken at least a day after `VACUUM FULL` finished.**
     - The day's margin covers not knowing whether `inserted_at` marks a backup's start or its end.
     - Reading the oldest backup covers off-schedule backups too.
     - On Pro, that's about 8 days after `VACUUM FULL`;
  2. **the plan's log retention after `finish_conversion`**: 7 days on Pro. It only binds on a plan whose logs outlive its backups, such as Team.
- **The date stays provisional while any [§9.5](#95-open-items) item marked *gates the date* is open.** Those items cover the copies no listing shows. A longer window from any answer moves the date, and so does turning PITR on, or adding a Log Drain.
- **The date covers a breach through SQL, the Storage API, the sync protocol or a backup.** A breach of the provider's hosts or disks still finds the residue accepted above, past the date. That includes the host's log file, which rotates by size ([§9.5](#95-open-items) S4).
- **Until the date, don't restore or duplicate the project from a backup.** That brings the plaintext back into a live database, and a backup from before the flip also undoes the conversion.
- **The run's dates stay private.** The run records when `VACUUM FULL` finished, and the date that follows, in a beads memory, which syncs only to the private remote. They never go in a public issue, PR or commit. Until the date passes, they tell anyone how long a backup breach would still yield the workspace's plaintext.

### 9.5 Open items

None of these blocks the run.
- An item marked *gates the date* names a copy, or a retention window, that the date waits for. [§9.4](#94-the-safe-from-rule) keeps the date provisional while one is open.
- The rest bear on the "live systems" line, or on what lies outside the date's boundary.

**For Vlad:** all four are answered, and recorded in [§9.1](#91-supabase-postgres):
- **V1.** No Log Drain is configured.
- **V2.** The hosted logging settings.
- **V3.** The plan is Pro.
- **V4.** `postgres` can vacuum all five of step 11's tables.

**For Supabase support:**
- **S1.** *(gates the date)* WAL is archived while PITR is off (`archive_mode = on`, measured). For how long is that archive kept?
- **S2.** *(gates the date)* Is a backup deleted from storage when it leaves the listing? Do off-schedule backups follow the same retention? Are backups encrypted at rest?
- **S3.** Does the S3 bucket behind Storage keep versions of deleted objects? Are keys with no `storage.objects` row, left by a failed delete or a failed upload, ever swept?
- **S4.** Is the instance's own Postgres log file ever pruned by age, rather than only rotated by size? Who can read it?

**For PowerSync support:**
- **P1.** Which storage version and backend is this instance on? What memory limit does Cloud's daily compaction use? When does a run do a full compaction rather than a chunk merge?
- **P2.** Does the storage engine keep the old bytes after a MOVE or a dropped stream? Is S3 object storage on for this instance?
- **P3.** *(gates the date)* Does PowerSync Cloud back up bucket storage, and for how long?
- **P4.** *(gates the date)* Do Cloud logs, diagnostics or traces ever hold row data, and for how long?

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
- **Reading the conversion's data from this device's PowerSync image.** Rejected: any held write keeps `ps_crud` non-empty, and the core publishes no checkpoint until it empties, so the image stops advancing for the whole run.
- **Inferring the phase from history** ("no history left" means purged). Rejected: sealed writes after the purge add history again. The `workspace_conversions` row is a fact that only the conversion's RPCs change.
- **`repo.setReadOnly` as the run's write barrier.** Not needed, and not owned by the flow: it's repo-wide and re-set on every workspace resolve (`src/App.tsx`). After the flip, #1293's gate closes the workspace and holds any write made for it until the purge is done.
- **Restoring from a device's own database.** Rejected: it holds only what that device downloaded and applied, and `repo.workspaceViewGap` can't close the gap, because it reads clear in the window after a reconnect, before the catch-up download starts (`src/data/internals/firstSync.ts`). Recovery points read the server instead.
- **A local verification record per re-sealed row.** Rejected: it has to survive a crash between a row's commit and the verify. The server's history already holds each row's pre-seal plaintext durably until the purge.
- **Taking the bundle before the flip.** Rejected: UI-state, preference and automation writes keep uploading until then (`CHANGE_SCOPE_POLICIES` in `src/data/api/changeScope.ts`), so the history snapshot could be raced right up to the flip. After it, the server refuses plaintext writes ([§6.1](#61-server)).
- **Key-loss recovery by delete and same-id restore.** Rejected. Every globally unique id, the workspace's and each block's, would have to be reserved across the gap. It also needed a restore RPC, a same-id importer and a pin-retirement gesture. Re-keying in place leaves no gap, and reuses the conversion's own steps.
- **Re-sealing through the PowerSync queue.** Rejected. It would need the pin flipped first, and would push hundreds of thousands of rows through the device-wide FIFO queue. Calling the patch RPC directly avoids both.
- **Suppressing history during the re-seal.** Not possible without privileged access. The purge removes the re-seal writes, and the disk headroom check accounts for them.

## 13. Tracking

| Piece | Issue | Waits on |
|---|---|---|
| Epic | #1295 | — |
| Server: flip RPC (with its table lock), guarded purge RPC, `finish_conversion`, `workspace_conversions`, mode admit, bucket limit, export index | #1294 | — |
| Clients: mismatch defer/hold, a gate that reads the conversion phase, use-time path derivation, one-way pin upgrade | #1293 | — |
| `row_events`: skip version-only updates | #1299 | — |
| Upload classifier: 25006 is transient | #1300 | — |
| Sealing pages | #1292 | — |
| Attachment conversion | #1291 | — |
| The in-app flow, including the recovery bundle | #1290 | #1291, #1292, #1293, #1294 |
| Key-loss recovery: in-place re-key from a recovery point | #1302 | — |
| Platform retention spike | #1289 | — |
| First production run | #1288 | #719, #1289, #1290, #1293, #1299, #1300 |
| Re-id migration (all e2ee workspaces) | #1297 | #719 |
| Upload parking: removes the sync stall a held write causes (deferred) | #1301 | — |
