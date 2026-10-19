# Key-loss recovery: re-keying an E2EE workspace in place

> **Status:** design, not built. Last verified against code: 2026-10-19, against master `ebbecd5ad5` (which has #1292, #1293 and #1294 merged). Its attachment rules follow the conversion doc as revised on #1313. Code wins where they differ.
> Tracking: #1302, under epic #1295. Its issue holds the requirements this design answers; [§12](#12-requirements-and-where-this-design-differs) maps each one to a section and names where this design departs from them, and why.

## 1. Goal

A workspace's key is lost: no device holds it and no saved copy survives. Recovery brings the workspace back **from its newest recovery point, under a new key, in place**:

- every block id survives, so every `((id))`, ref property, backlink and URL keeps working, and no id is ever free for another caller to claim;
- the content, tree, timestamps and authorship become the recovery point's;
- attachments are rebuilt under the new key.

**It's point-in-time, not lossless.** Everything written after the recovery point is lost, because nothing else holds that plaintext. The flow says so, with the point's time, before it starts. That includes records an extension could otherwise re-fetch: a post-point record's id holds a recovery tombstone, and an extension that refuses tombstones (`getOrCreateTypedChild`) won't re-create it (open question 3).

It applies to **any** e2ee workspace with a recovery point, whether it was converted (`docs/workspace-e2ee-conversion.md`) or created e2ee. A recovery point is a folder holding `blocks.jsonl` (every block row, every column, plaintext), the plaintext of every media block, and a manifest. It is one of:

- **a step-14 point** (conversion runbook step 14), taken on an unlocked device ([§9](#9-the-flow) specifies the gesture);
- **the conversion's recovery bundle** (conversion §6.3 step 3), which has the same three parts plus some it doesn't need.

A raw SQLite export is not a recovery point, and neither is a device database ([§11](#11-alternatives-considered)).

Non-goals:

- routine key rotation;
- recovering anything newer than the point;
- recovering with other clients active. The conversion's single-client contract (conversion §3) applies unchanged: one device, one tab, every other device closed. The design makes breaking it fail closed where that's cheap.

## 2. Shape

Recovery is the conversion's machinery run again, with a recovery point as the plaintext source, under a new key:

| Conversion piece | What recovery does with it |
|---|---|
| `workspace_conversions` and its phase (#1294) | adds a third phase, `recovering` |
| the flip's admit and lock order | the re-key RPC takes both unchanged |
| the gate that reads the phase (#1293) | treats `recovering` like `sealing` |
| verify's check, repair and read-back loop (#1292) | runs it against the point, widened to whole rows |
| the attachment cleaner (#1291) | runs it under the new key, with the point as its input |
| the one-way pin upgrade (#1293) | becomes **adoption**, the one place a device makes a key current for an existing workspace |

Two things are new, because no conversion piece covers them:

- **a fence on every block write.** Each write carries the key generation its writer was looking at when it made the write. The server refuses a stale one, and a restore write from a superseded attempt ([§3.2](#32-the-write-fence));
- **adoption's wait.** A device doesn't admit edits under the new key until its own copy of the workspace is past the re-key ([§6.3](#63-entry-and-adoption)).

The run, on the owner's device:

```
verify point → mint key → rekey_workspace → begin_recovery_attempt → restore → attachments → finish_recovery → adopt
               (pending)   phase → recovering     token                                      phase → none / cleaning / sealing
```

## 3. Server

One migration, on top of #1294's.

### 3.1 State

- **`workspaces.wk_generation integer not null default 0`.** Counts re-keys. `create_workspace` and the flip leave it at 0; only `rekey_workspace` changes it, by +1, in the same statement that replaces `wk_canary`.
  - `workspaces_prevent_e2ee_field_change` guards it with the mode and the canary. Its early return must compare all three: today it passes any update that leaves the mode and canary alone, and editors can update `workspaces`, so an editor could otherwise bump the generation and stall every device's writes.
  - It's added to the synced `workspaces` columns (`scripts/gen-sync-config.ts`, `src/data/workspaceSchema.ts`), so a device always holds a canary and its generation from one checkpoint.
- **`workspace_conversions.phase` admits `recovering`.** The row means what it already means: a server fact that the workspace is mid-change, and that no device may treat it as ready.
- **Two nullable columns on `workspace_conversions`:**
  - `recovery_attempt uuid`: the live attempt's token ([§3.2](#32-the-write-fence));
  - `return_phase text`: the phase recovery interrupted, `cleaning` or `sealing`, or null for none.

  A CHECK keeps both null unless the phase is `recovering`, so no token can outlive the phase. Members can read the token under the existing RLS policy. It's a fence, not a secret: a member who copies it gains nothing writing garbage envelopes doesn't already give them.

### 3.2 The write fence

**Why it's needed.** No envelope names the key that sealed it: `enc:v1:` is the prefix plus nonce and ciphertext (`src/sync/crypto/envelope.ts`). And `blocks_require_ciphertext_for_e2ee` checks only the shape. So after a re-key the server would accept a write from a device that made it against the pre-recovery workspace. That covers a queued backlog, an undo replay, an edit in a stale tab, or a request delayed past the re-key, and it holds whichever key the device seals it under. Any of them would put pre-recovery content, or an unreadable row, back over the restore.

**What a write carries.** Each element of `apply_block_patches` and `apply_block_creates` may carry two more wire-only keys, as patches already carry `base_updated_at`:

- `wk_generation`: for a device's own writes, the generation its tab had entered the workspace at when it **made** the write ([§6.1](#61-the-tabs-generation)). It's not taken from the key at send time;
- `recovery_attempt`: only on a recovery's own writes.

Each RPC publishes them to transaction-local settings (`km.write_wk_generation`, `km.write_recovery_attempt`) right before the statement for that element, and clears them right after, as `apply_block_patches` does today for `km.patch_base_updated_at` (`20260803000000_add_patch_base_version_drift_bump.sql`). A value that isn't well-formed reads as absent. A create's insert-or-touch is one statement, so its touch carries the same stamp.

**What the server checks.** `blocks_require_ciphertext_for_e2ee` stays the one owner of the e2ee write rule. The workspace's conversion row is read through a SECURITY DEFINER helper, so the check never depends on the writer's RLS. On top of "every content column is sealed", it refuses with SQLSTATE `23K01`, giving a message that says which rule failed:

- **a stale generation**, for a row in an e2ee workspace: a stamp that differs from `wk_generation`, or no stamp once `wk_generation > 0`. A missing stamp passes while the generation is 0, so builds that don't stamp keep working in every workspace that was never re-keyed;
- **the wrong attempt.**
  - While the workspace's phase is `recovering`, only a write carrying its live `recovery_attempt` lands, and none lands while no attempt is live.
  - Outside `recovering`, a write carrying any attempt is refused. A workspace that isn't e2ee is never `recovering`, so that also keeps a delayed restore write, or one aimed at another workspace's row, from landing.

  The conversion row is read only for a row in an e2ee workspace, or for a write that carries an attempt.

`23K01` is class 23, which `classifyUploadError` treats as permanent. A refused device write therefore goes to the rejection quarantine (`ps_crud_rejected`), user-visible and retryable, through the path refusals already take.

**Why it's atomic.** The trigger reads the generation and the attempt without a lock, as it reads the mode today. Every RPC that changes either takes `LOCK TABLE blocks IN SHARE MODE NOWAIT` last, as the flip does ([§3.3](#33-rpcs)). So no block write is in flight when the change commits, and every later write sees it.

**What it doesn't cover.**

- **A `DELETE` on `blocks`** doesn't fire the trigger. Clients never delete (there's no delete upload trigger in `clientSchema.ts`). The restore's last check counts the workspace's rows ([§4.4](#44-completion)), so a delete during the restore fails that check and the run resumes. One after the restore is out of scope, as any operator delete is.
- **Storage uploads** aren't fenced. An old-key object lands at an old-`K_id` path that no block's address derives to any more ([§5](#5-attachments)).

### 3.3 RPCs

All three are owner-only SECURITY DEFINER functions granted to `authenticated`, with #1294's refusal code `KMC01`. Each takes its locks in the flip's order, all NOWAIT:

1. the `workspaces` row;
2. then the `workspace_conversions` row, if one exists;
3. then `LOCK TABLE blocks IN SHARE MODE`, **last**.

A refusal that needs no lock is decided before them.

`55P03` means the table lock wasn't granted. The cause may be a write in flight in any workspace, or an autovacuum of `blocks`, which can last a while. The flow retries all three with unbounded backoff, as the conversion retries its flip, and the message doesn't claim a cause.

**`rekey_workspace(ws, canary, expected_generation)`** replaces the key.

- It refuses unless:
  - the caller owns `ws`;
  - `canary` is an `enc:v1:` envelope;
  - the mode is `e2ee`;
  - `wk_generation = expected_generation`.

  The last check makes the re-key compare-and-set. Two owner devices can't both re-key and leave the first one's saved key silently dead.
- It's admitted by the flip's mechanism: `current_user = 'postgres'` and a transaction-local `km.rekey = ws` that only it sets. `workspaces_prevent_e2ee_field_change` admits exactly `e2ee → e2ee`, with a new well-formed canary and `wk_generation = old + 1`.
- Its transition depends on the phase it finds:

  | Phase found | After |
  |---|---|
  | none | `recovering`, `return_phase` null |
  | `cleaning` | `recovering`, `return_phase = 'cleaning'` |
  | `sealing` | `recovering`, `return_phase = 'sealing'` ([§7](#7-key-loss-during-sealing)) |
  | `recovering` | `recovering`. The new key was lost too; `return_phase` is kept |

  In every case it clears `recovery_attempt`, so no earlier run's writes land from here on.
- It changes no block. It gives an owner nothing `delete_workspace` doesn't already.

**`begin_recovery_attempt(ws) returns uuid`.**

- It refuses unless the phase is `recovering`.
- It sets and returns a fresh token.
- **Every run calls it**, a resume included. Each run re-checks every row ([§4.4](#44-completion)), so a fresh token costs nothing, and it kills every earlier run's in-flight writes. That makes a run on a second owner device a clean takeover, not a race.

**`finish_recovery(ws, attempt)`.**

- It refuses unless the phase is `recovering` and `attempt` is live.
- It then moves the phase to `return_phase`, clearing both columns. A null `return_phase` deletes the row.
- Its table lock means no restore write is in flight when the token dies.

`purge_workspace_history` and `finish_conversion` already refuse any phase but their own. So neither can run during `recovering`, a delayed purge from before a sealing re-key included.

## 4. The restore

Recovery's check of every row is #1292's `verifyReseal` loop. Per page of server rows, by id, it finds the rows that differ from what they should be, re-sends them through `sealAndSend`, reads them back, and refuses any still wrong. It ends with `requireWholeWorkspace`'s count. In verify, "what they should be" comes from the server's re-seal records. In recovery it comes from the point, and the comparison covers whole rows.

### 4.1 The point, verified and bound

Before anything irreversible, and again on every resume (since the folder may have changed), the flow checks all of the following:

- every part's sha256 matches its manifest entry;
- `blocks.jsonl` has exactly the manifest's block count, with no id repeated. Every row the point lacks is tombstoned, so a truncated file must never pass;
- **binding:** the manifest's workspace id, and every row's `workspace_id`, equal the target. A point from another workspace would otherwise tombstone every target row, and try to recreate that workspace's ids here. The attempt fence would refuse those creates' touches on the server as well ([§3.2](#32-the-write-fence));
- the manifest's `properties_migration` equals the workspace's current state. The switch is forward-only, so rows from an earlier stage would read wrong in a workspace that has moved past it (open question 2);
- every media block has an `attachments/` entry whose bytes hash to its name, or its hash is on the manifest's list of hashes with no verified source ([§5](#5-attachments)).

The point is then indexed once, mapping each id to its line offset in `blocks.jsonl`. Rows are read by offset through the folder handle, so the order of the server's `ORDER BY id` never has to match the file's.

### 4.2 The expected row

For each server row, the **expected row** is one of two things:

- **The point's row, if it has one.** That means its three content columns as plaintext, plus `parent_id`, `order_key`, `deleted`, `created_at`, `user_updated_at`, `created_by` and `updated_by`. So moves, reorders, deletes and undeletes since the point are undone too.
  - **Never `updated_at`.** It's the row version: the clamp floors it at the old value and bumps it on a content change, so a restored row's version always advances.
- **The tombstone form, if it doesn't.** The row was created after the point. Its content is `''`, `'{}'` and `'[]'` sealed **under the new key**, and `deleted` is true; its other columns are left as they are. The content is re-sealed so that a device still holding the row live can open the tombstone and apply it.

### 4.3 Order of work

Each attempt runs three steps, all stamped with the new generation and the attempt token:

1. **Recreate.** Page the server's ids only. Any point id the server lacks was hard-deleted after the point; that only happens outside the app, and the history trigger records it.
   - Recreate them through `apply_block_creates`, with the point's row sealed under the new key. `updated_at` is the flow's clock, which the clamp caps.
   - **One row per call.** Recreates are rare, and a call is one transaction, so a refused row in a shared call would roll back its siblings without saying which one failed.
   - Parents go before children, since `blocks_workspace_id_parent_id_fkey` is checked at each call's commit. Recreates go before any patch, so a patch that moves a row back under a hard-deleted parent finds the parent present.
   - An id that already exists in another workspace can't be recreated, and neither can its point descendants. The create's touch is refused by RLS, or by the attempt fence. Those ids go on the **unrestored** list ([§4.4](#44-completion)).
2. **Check and repair**, verify's loop. A differing row is sent as one `apply_block_patches` element:
   - its expected content, sealed under the new key and opened back before sending, as today;
   - its expected metadata columns;
   - `base_updated_at` from the server row just read.

   It never carries `updated_at` or `workspace_id`. A `P0002` (the row vanished between read and patch) fails the run, which resumes.
3. **Count.** The pass must have seen as many rows as the server counts (`requireWholeWorkspace`). Recreates happened before it, so they're counted.

**Engine changes**, in `src/sync/conversion/`:

1. `readBlockPage` and `readBlocks` select every column.
2. A `SealTarget` may carry metadata columns into its patch.
3. `ConversionServer` gains `applyBlockCreates` and an id-only page read.
4. Every call takes the stamps.

The conversion's own re-seal still sends no stamp. At generation 0 that's admitted, and after a re-key it must not be ([§7](#7-key-loss-during-sealing)).

### 4.4 Completion

A row is restored when **both** hold:

- its content columns open under the new key to the expected plaintext (`opensTo`, which compares values, since a value that opens only proves which key sealed it);
- every expected metadata column is equal.

A row still wrong when its repair is read back goes on the unrestored list below. Verify refuses the run at that point (`unrepaired`); recovery carries on, so the list is complete. The clamp could cause such a row by rewriting a `created_at` or `user_updated_at` later than server time, but a point's rows were clamped when they were written.

The attempt fence means only this attempt writes while it is live, so one complete pass with no refusal finishes the restore. A crash, a refusal, a vanished row, or a count that doesn't match makes the next run start over.

**The restore's terminal outcome** mirrors the attachments': **passed, with these rows unrestored**. The list holds:

- ids taken by another workspace, and their point descendants;
- rows still wrong after their repair.

The flow shows the list, and `finish_recovery` follows only the user's confirmation. Without this outcome, the only way out of `recovering` would be a run with nothing to list, so one stuck row would keep every device gated.

### 4.5 Resume

The restore keeps no local state: **the server's rows are the progress**. A resume runs the attempt again, and a row already equal costs one read and one open.

This device keeps a **recovery record** for the point, as the conversion keeps its bundle record: the directory handle and the manifest's hash. A resume re-opens that folder and re-verifies it ([§4.1](#41-the-point-verified-and-bound)). On another device, or once the folder is gone, the flow asks the user to pick a point.

Switching points between runs is safe. Each run re-checks every row against its own point, so no row ends up holding values from two points. The one exception is a tombstone: it keeps whatever metadata an earlier run gave the row, which no device shows.

## 5. Attachments

Recovery runs #1291's cleaner under the new key, as a **standalone run**: with no bundle record, even on a device that holds one. Its inputs come from the point, not from this device:

- **the media blocks to prove:** the point's media rows, which after the restore are exactly the server's. This device's database still holds the pre-recovery tree until it adopts ([§6.3](#63-entry-and-adoption)), so it can't be the source.
- **the bytes:** the point's `attachments/`. The point is verified to hold every media block's bytes or list it ([§4.1](#41-the-point-verified-and-bound)). The local byte store doesn't help here, because entries captured after the conversion are named by `HMAC(K_id_old, hash)`, which no lookup under the new `K_id` finds (`deriveObjectKey`).

So #1291's cleaner has to take both as inputs, as #1292's engine takes its plaintext source.

Under the new key, the classification rule (unchanged) gives:

- **Every keyed object from the old key reads as *neither*.** A standalone run reports *neither* and never deletes it, so **old-`K_id` objects are kept**, as are old key records ([§6.2](#62-key-records)), in case the old key turns up.
  - The conversion's own *neither* deletion touches only paths its bundle record archived. Those were listed right after the flip, before any keyed object existed.
- **Every media block's object at its new keyed path** (`HMAC(K_id_new, hash)`) starts out missing. The proof rebuilds each one: seal, upload, verify with the shared helper.
- **Raw objects** an old client left are converted, as in any standalone run.

**The proof is the conversion's** (conversion §6.3 step 8), minus its clause about objects a bundle archived under `other-objects/`. That clause needs a bundle record, which a standalone run doesn't have. A recovery that interrupted `cleaning` returns there, and the conversion's own pass still owes it.

- **Blocks with no bytes.** Each point's manifest lists the media hashes that no source verified when the point was taken: conversion §6.3 step 3 for the bundle, and runbook step 14, which re-derives the list each time. The proof reports those blocks as unrecoverable. The terminal outcome is the conversion's: **passed, with these blocks unrecoverable**, confirmed by the user before `finish_recovery`.
- **A refused upload**, such as a 413 for an object over the upload limits, holds the proof, with the conversion's remedy: raise the limits (conversion §6.3 step 0).

**Accepted residue.** Each device's byte-store entries named under the old `K_id` stop being found. Media re-downloads from the rebuilt objects on demand, and the old local entries stay on disk until a later cleanup.

## 6. Devices

### 6.1 The tab's generation

Each tab holds, per workspace, the **generation it entered at**. That's the `wk_generation` of the synced `workspaces` row whose canary its key opened at entry ([§6.3](#63-entry-and-adoption)). That number has two jobs:

- **Every local write records it.** The engine puts it in the transaction's context, which already carries `source` and `tx_seq` (`tx_context`). The upload triggers copy the row's workspace's value into the queued write, beside `base_updated_at`, and the connector sends it as the write's stamp. A write therefore says which workspace its writer was looking at, however late it's sealed or sent. A tab that never pinned the workspace e2ee records none.
  - **Compaction keeps the oldest stamp.** When the connector merges one block's patches from several transactions (`compactBlockCrudEntries`), the merged write carries the oldest stamp, with an absent one counting as oldest. That's the rule it already applies to `base_updated_at`. Otherwise a current patch could carry a stale patch's columns past the fence.
- **Taking a new one resets the tab's view.** Before a tab takes a new generation for a workspace, it empties that workspace's undo and redo stacks and evicts its rows from its in-memory cache. Its next reads then hydrate from disk.

Together these make every pre-recovery write refusable, in every tab, with no cross-tab coordination:

- A backlog, an edit or an undo replay from a tab still at the old generation carries the old stamp. The fence refuses it ([§3.2](#32-the-write-fence)), and it lands in the quarantine.
- A tab at the new generation has no pre-recovery undo history to replay.

**Retry** in the rejection dialog re-stamps a write with the retrying tab's current generation. That's the user saying "send this now". Retry today re-queues one row of a quarantined transaction at a time. Adoption quarantines whole backlogs, which makes multi-row transactions common, so #1322 tracks re-queuing them whole.

### 6.2 Key records

`WorkspaceKeyStore` keeps one record per (user, workspace), and `put` overwrites it. Recovery adds two slots and nothing to the record itself, which carries no generation:

- **A pending slot** per (user, workspace). It holds a key the recovery flow minted, revealed, had retyped, and stored after a probe write, all **before** `rekey_workspace`. That's the conversion's key step, aimed at a slot nothing seals with.
  - Only adoption moves it to current, and adoption clears it.
  - The key gates offer a pending key that opens the server canary before prompting for one.
- **An archive** per (user, workspace). Adoption never overwrites a record: it appends the current one to the archive first. The app never reads the archive back; it only keeps it, in case the old key turns up.

### 6.3 Entry and adoption

**Entry** stays local. For an e2ee pin with a key, today's `resolveWorkspaceEntry` returns `ready` with no network read. It now also opens the **synced** canary with the key:

- **It opens:** `ready`, and the tab enters at the synced generation.
- **It doesn't:** locked, `key-replaced`. That gate reads the live phase on mount, as `ServerE2eeGate` does:
  - during `recovering`, it shows the closed state, and on the owner's devices offers to resume the recovery;
  - otherwise, it offers to adopt the new key.

A tab watches the synced `wk_canary` of each workspace it has open, and re-resolves entry when it changes. #1293's gate for non-e2ee pins gains one phase: `parseConversionPhase` parses `recovering`, and `checkServerE2eeEntry` returns its closed state for it. An older build reads the unknown value as `sealing`, which is also closed.

Entry doesn't need the server. Its job is to stop a device decrypting or writing with a key that isn't the workspace's. The fence makes a device that's merely behind on sync harmless: its writes carry its old generation and are refused, and its restored rows fail to decrypt until it adopts.

**Adoption** is #1293's one-way pin upgrade, generalized. It's the one place a device makes a key current for an existing workspace. Four paths reach it:

- the `key-replaced` gate;
- the key-required gate (an e2ee pin whose record was evicted);
- #1293's pin upgrade, on a device that deferred through a conversion or is meeting the workspace for the first time;
- the recovering device itself, after `finish_recovery`.

In order:

1. **Read the server, live.** Unavailable means wait: the phase isn't synced, so offline adoption could open a workspace mid-recovery or mid-sealing. The phase must be none or `cleaning`, and the key must open the server canary. Call its generation *G*.
2. **Write the marker** (#1293's pin-upgrade marker).
3. **Store:** append the current record to the archive, put the new one (clearing the pending slot), and set or upgrade the pin.
4. **Wait for the image.** The device's synced canary must open under the key, meaning the checkpoint holding the re-key has arrived. Until then the gate shows that the workspace is downloading.
   - Storing the key first is what unsticks this. Any of the workspace's queued writes that couldn't be sealed now seal, carry their stale stamps, are refused, and leave `ps_crud`. While `ps_crud` is non-empty, `ps_crud_hold_downloads` publishes no checkpoint.
   - A write held for *another* workspace still stalls downloads. That's the stall #1301 removes.
5. **Quarantine the stale backlog.** Every queued transaction holding a write for the workspace that the fence would refuse moves to `ps_crud_rejected`: a stamp other than *G*, or none once *G* is above 0. At generation 0 that's nothing, so a conversion's held writes still upload after its pin upgrade, as #1293 designed. Each one moves in one write transaction, keyed by `tx_id` as `recordRejectionToTable` keys it, so a concurrent refusal of the same transaction leaves one copy. This matters only for writes the uploader can't reach, behind a write held for another workspace, because the next step skips any row with a queued write.
6. **Re-materialize:** `drainWorkspace(ws, 'all')`. If a staged row still doesn't open under the key, rows are still arriving: wait, then repeat from step 5.
   - After a recovery every server row opens under the new key, which the restore proved, and the fence refuses any other key. So this ends once the device has caught up.
   - On a workspace never re-keyed, #1293's rule stands: a row that doesn't open doesn't hold the marker.
7. **Clear the marker.** The tab, and the device's other tabs on their next entry, then enter at *G* ([§6.1](#61-the-tabs-generation)).

**Crash and resume.** A crash before step 2 leaves the old key, or none, so the gate re-enters adoption. With the marker set, startup's `resumePinUpgrade` runs. It now first checks the stored key against a live read of the canary:

- **It opens:** resume from step 4.
- **It doesn't:** the crash came before step 3, so the marker is dropped and the key gate appears. It offers the pending key, if there is one.
- **The server can't be read:** the device stays gated, with the marker kept.

Every other tab of the device sees the marker through entry, which checks it first, and stays gated until it clears.

**Changed invariant.** "The phase only moves forward" no longer holds: a recovery can begin after the conversion has finished. The comments that state it change with this:

- `conversionState.ts`'s header;
- `upgradeWorkspacePin.ts`'s resume ("the phase never moves back");
- conversion §6.3.

`resumePinUpgrade` can stay local only because step 1 and the resume check above read the server.

## 7. Key loss during sealing

A re-key during `sealing` goes through `recovering`, with `return_phase = 'sealing'`, like any other recovery. The point is the conversion's bundle.

- **The bundle is a complete plaintext copy.** Nothing but the re-seal writes during `sealing`. If it's lost too, it's re-taken without a key, as conversion §6.3 step 3 already provides.
  - Unsealed rows are read verbatim.
  - Sealed rows come from the `before_diff` of their latest plaintext-to-envelope history row.
  - A restore write over a row the re-seal had sealed goes from envelope to envelope, so it never counts as that record. One over a row still plaintext does count, and its `before_diff` is that same plaintext.
- **Content only.** With the bundle current, the restore has nothing to recreate or tombstone, and no metadata to change. If it finds any of those, the bundle is stale, and the attempt stops **before writing**. It re-takes the bundle, then starts a new attempt. That keeps every restore write a content-only `U` row writing envelopes, which `is_reseal_history_row` accepts. It also keeps a stale bundle's values from ever being written, and then archived as the truth.
- **Back to the conversion.** `finish_recovery` returns the phase to `sealing`. The bundle the restore used is the conversion's bundle record. The conversion's flow (#1290) then sees `sealing` with `wk_generation > 0` and skips re-seal and verify:
  - every row is sealed already;
  - verify's records for rows re-sealed before the key loss open only under the lost key;
  - the restore's check stood in for verify.

  It purges with `through` and the count from the bundle's verified manifest.

`recovering` also closes two holes that `sealing` alone would leave:

- **A purge sent before the re-key can't land in the middle,** since the purge refuses any phase but `sealing`.
- **The attempt token fences restore writes** from an abandoned run.

The old key's re-seal batches still in flight carry no stamp, and the generation is now above 0, so the fence refuses them. #1292's engine needs no change for that.

Re-keying before the first re-sealed row takes the same path. It's equivalent there, since every row still equals the bundle.

## 8. Derived ids across a `K_id` change

`K_id` is `HKDF(WK, 'km/asset-content-key/v1')` (`src/sync/crypto/contentKey.ts`), so a new key moves every namespace derived from it. The rotation note in `src/sync/crypto/derivedIdNamespace.ts` names the consumers.

**Synthesized property definitions.** Their ids are `derivedBlockId` under `deriveWorkspaceIdNamespace(K_id, 'km/property-definition-ns/v1')`. Re-iding them is out, because field rows point at definition ids. The two cases behave differently:

- **A live definition survives.** Synthesis asks who holds the *name* (`nameHolding`, over live rows), finds the old-id definition, and converges.
- **A deleted one would come back.** A deletion is honoured only through `classifyOccupant` at the *derived id*. The tombstone sits at the old id, the new id reads `absent`, and the pass mints. That breaks "a deletion is an instruction".

**The rule.** When the workspace's synced `wk_generation` is above 0, synthesis also looks for a **deleted** definition block that stores the candidate's name, at any id in the workspace. If there is one, it skips the key with the same reason the tombstone verdict gives.

- **Where it goes:** after the `held` branch, so a live holder still converges, and before `classifyOccupant`.
- **Its query:** a tombstone-inclusive sibling of `tx.livePropertyDefinitionNames`.
- **Why the name is still there:** a restored deletion keeps its content, because soft-deleted rows do. A recovery tombstone has empty content, so a definition created after the point never blocks a re-mint, and the point never had it anyway.

Both comments in `propertyDefinitionSynthesis.ts` that call `K_id` "immutable until rotation exists" change to: it changes only through recovery, behind the gate. A synthesis pass that a canary change interrupts writes under its tab's old generation, so the fence refuses it.

**Media blocks.** Their ids hash `${ws}:${contentKey}`, and in e2ee the content key is `HMAC(K_id, sha256)`. Existing ids don't change, and their paths derive at use time. Re-capturing a file after recovery mints a second block, which is accepted.

## 9. The flow

One guarded in-app flow on the owner's device. It holds `navigator.locks` per (user, workspace), re-confirms the single-client contract on every run, and reads the server directly, as the conversion's flow does.

**0. Preflight.** It refuses unless all of these hold:

- the user owns the workspace;
- it's e2ee;
- the key store is durable;
- the File System Access API is available.

The user picks a point. It's verified ([§4.1](#41-the-point-verified-and-bound)), its export time is shown with "everything after this is lost", and the user confirms.

**1. Key.** If the pending slot holds a key, the run reuses it. Otherwise it mints one: generate, derive `K_id`, mint the canary, re-parse the **displayed** string, reveal it once, have it retyped, probe-write, store as pending.

**2. Re-key.** `rekey_workspace(ws, canary, generation read in step 0)`. If the server canary is already the pending key's, an earlier run got this far, and the step is skipped.

**3. Attempt.** `begin_recovery_attempt(ws)` returns the token.

**4. Restore** ([§4](#4-the-restore)), with a progress view and a wake lock.

**5. Attachments** ([§5](#5-attachments)).

**6. Finish.** Confirm any unrestored rows and unrecoverable blocks, then call `finish_recovery(ws, token)`.

**7. Adopt** on this device ([§6.3](#63-entry-and-adoption)). After a `sealing` return, adoption refuses until the purge. So the conversion's own step 7, its pin upgrade, is this adoption, and until then the conversion's flow finds the key in the pending slot.

**8. Done.** The report says:

- old key records and old-`K_id` objects were kept;
- other devices will ask for the new key, and their pre-recovery writes will land in the rejection quarantine;
- **take a new step-14 point now**, since every older point predates the new key.

A failed RPC with `55P03` retries; any other failure stops the run, and the next run resumes. Every run starts from what the server shows:

| Server shows | Next |
|---|---|
| `recovering`, canary opens under the pending key | step 3 |
| `recovering`, canary opens under no key here (owner) | ask for the new key, store it as pending, then step 3. If that key is lost too, step 1: re-keying again is admitted |
| `recovering` (not the owner) | the gate's closed state |
| no `recovering` row, canary opens under the pending key | step 7, or the conversion's flow if the phase is `sealing` |
| no `recovering` row, canary doesn't | step 0. The pending key is kept: the user saved it |

**The step-14 gesture** ("take a recovery point") is #1302's. It reuses #1290's folder writer and verifier, and follows conversion runbook step 14:

- **Rows** come from server pages opened under the key. The paging is bracketed by the same consistency check as the bundle's: the workspace's history count must be the same before and after, or the rows are re-read. Every block write adds a history row, so a file that passes is one instant.
- **Media bytes** come from whichever source verifies.
- **The no-verified-source list** is re-derived when the point is taken.

It refuses to take a point while any row doesn't open, and lists those rows, since the restore needs an expected value for every row. The manifest records:

- the workspace id;
- the block count;
- each part's hash;
- the export time;
- `properties_migration`;
- the hashes with no verified source ([§5](#5-attachments)).

**Who builds what:**

- **#1302:** the steps above and the gesture.
- **#1290:** the conversion-side pieces of [§7](#7-key-loss-during-sealing): skipping re-seal and verify, treating the restore's bundle as its record, and looking for the key in the pending slot first.
- **#1290:** the "offer to finish" on an e2ee-pinned owner device in `cleaning`, which the #1293 hand-over already gives to #1290. A recovery that returns to `cleaning` relies on it.

## 10. Fleet gate

Conversion runbook step 1 requires #1302's client half on **every** device before the first production conversion. With the server fence, **that's no longer needed for safety**. A build without the client half fails closed in a re-keyed workspace: its writes carry no stamp, so they're refused and quarantined, whatever key it holds and however it got it. Its restored rows fail to decrypt until it updates. Updating then puts it through entry and adoption, as any other device. What remains is the safety net itself: #1302's server half and flow must exist before the first conversion (runbook step 1's last bullet). Relaxing runbook step 1 is open question 1.

## 11. Alternatives considered

- **Stamping the generation at send time, from the key record.** That was this doc's first draft, and it breaks in three ways:
  - a pre-recovery backlog or undo replay, sealed after the device stores the new key, would carry the new generation and pass;
  - other tabs would need coordinating;
  - a record stored by an older build, with no generation, would stamp 0 forever.

  Write-time stamping makes "pre-recovery" a property of the write itself.
- **A client-side pre-send fence in the connector** (in the requirements). It isn't atomic with the write, so the server fence is needed anyway, and its `hold` would cost more than a refusal: while anything sits in `ps_crud`, `ps_crud_hold_downloads` stops the device's downloads for **every** workspace.
- **A key generation stored on each block row.** Rejected: `apply_block_patches` keeps any column a patch omits, so an old client's patch would inherit the row's current value and pass.
- **Re-keying during `sealing` without leaving `sealing`** (in the requirements). Rejected: a purge sent before the re-key could land mid-restore and move the workspace on with rows sealed under the lost key. Restore writes would also have no attempt fence. Going through `recovering` keeps both of the reasons `sealing` was kept: every device stays gated, and the purge still runs, after the recovery.
- **Finishing recovery to no row always** (in the requirements). Rejected when recovery interrupted `cleaning` or `sealing`: the conversion still owes its purge or its cleanup, and only its phase brings them back.
- **An entry check against the server on every open** (in the requirements). Not needed. The fence makes a device that's behind on sync harmless, and adoption, the one step that can open a workspace under a new key, reads the server.
- **Recording the chosen point on the server.** Dropped. Switching points is safe, and on another device the server could show only a hash, not the point's time.
- **Restoring from a device database, or through the PowerSync queue.** Rejected for the conversion's reasons (conversion §12): a device holds only what it downloaded, and the queue would need the pin first and push every row through one FIFO.
- **Delete and same-id restore.** Rejected in the conversion doc: ids would be free across the gap.

## 12. Requirements, and where this design differs

Every requirement in #1302 has a home:

| Requirement in #1302 | Where |
|---|---|
| owner-only re-key, the flip's admit and lock order, new key stored first | [§3.3](#33-rpcs), [§6.2](#62-key-records) |
| whole-row restore, tombstones under the new key, completion by equality | [§4.2](#42-the-expected-row)–[§4.4](#44-completion) |
| recreate hard-deleted rows; refuse a foreign id | [§4.3](#43-order-of-work) |
| bind and verify the point; restore only from its `blocks.jsonl` | [§4.1](#41-the-point-verified-and-bound) |
| attachments rebuilt; old objects and key records kept; the list of bytes no source verifies carried | [§5](#5-attachments), [§6.2](#62-key-records) |
| entry checks the key against the canary, and again when it changes | [§6.3](#63-entry-and-adoption) |
| server fence on old-key writes; per-attempt token invalidated by finish | [§3.2](#32-the-write-fence), [§3.3](#33-rpcs) |
| quarantine the pre-recovery backlog; undo clear; rematerialize before admitting edits | [§6.1](#61-the-tabs-generation), [§6.3](#63-entry-and-adoption) |
| gate every device for the whole recovery | [§3.3](#33-rpcs), [§6.3](#63-entry-and-adoption) |
| synthesized-definition tombstones survive | [§8](#8-derived-ids-across-a-k_id-change) |
| key loss during `sealing` | [§7](#7-key-loss-during-sealing) |

These are met differently from how the issue words them:

| The issue says | This design | Why |
|---|---|---|
| fence uploads at the connector | no connector fence | [§11](#11-alternatives-considered) |
| entry reads the server canary, never the synced row alone | entry reads the synced canary; adoption reads the server | [§11](#11-alternatives-considered) |
| quarantine the backlog before storing the key | stale writes are identified by their write-time stamp, so the order no longer matters, and the move comes after storing (it unsticks the queue) | [§6.3](#63-entry-and-adoption) |
| `sealing` stays `sealing` | `sealing` → `recovering` → `sealing` | [§11](#11-alternatives-considered) |
| finishing → no row | → the phase recovery interrupted | [§11](#11-alternatives-considered) |
| before the first re-sealed row: re-key and continue the conversion | the same restore path, equivalent there | [§7](#7-key-loss-during-sealing) |
| fleet gate before the first conversion | not needed for safety; open question 1 | [§10](#10-fleet-gate) |

## 13. Open questions

1. **Relax conversion runbook step 1?** Recommendation: yes. #1302's server half and flow must exist before the first conversion; its client half need not be on every device ([§10](#10-fleet-gate)). This changes the conversion doc, so it waits for a yes.
2. **A point from before a properties-as-blocks switch.** [§4.1](#41-the-point-verified-and-bound) refuses it. If that's the only point left, the workspace can't be recovered. Recommendation: refuse, and have the switch prompt for a new step-14 point once it's done. The alternative is to re-run the switch's backfill after the restore, which first needs that backfill to be safe to re-run.
3. **Extension records after the point.** Their ids hold recovery tombstones, and `getOrCreateTypedChild` refuses a tombstone, so an extension won't re-create a record it could re-fetch. Recommendation: accept, since it's within point-in-time. The alternative is a recovery tombstone that `classifyOccupant` treats as absent, which is a kernel change.
4. **The synthesis rule's scope.** Recommendation: only re-keyed workspaces, as [§8](#8-derived-ids-across-a-k_id-change) says. Applying it everywhere would also honour a deleted hand-made definition of the same name. That may be right, but it changes behaviour for every workspace.

## 14. Tracking

| Piece | Where |
|---|---|
| Migration: `wk_generation` (synced), the `recovering` phase and its two columns, the fence, the stamp keys in both write RPCs, the three RPCs, pgTAP | #1302 |
| Engine: whole-row targets, wide and id-only reads, creates, stamps, the restore on verify's loop | #1302, on #1292's module |
| Write-time stamp: tab generation, `tx_context`, upload triggers, connector, Retry re-stamp | #1302 |
| Key store: pending slot and archive | #1302 |
| Entry check, canary watcher, `key-replaced` and `recovering` gate states | #1302, on #1293's gate |
| Adoption: live read, wait for the image, backlog quarantine, drain | #1302, generalizing #1293's pin upgrade |
| Synthesis rule | #1302 |
| The cleaner takes its media set and bytes as inputs | #1291 |
| Sealing return; offer to finish on e2ee-pinned owner devices; folder writer and verifier | #1290 |
| The recovery flow, and the step-14 gesture | #1302 |

**Done when** (from #1302, plus the fence):

- pgTAP pins:
  - the re-key refuses non-owners, plaintext rows, calls outside the admit, and a stale `expected_generation`;
  - a generation-only update is refused;
  - the fence refuses a stale or missing stamp once re-keyed, any write without the live attempt while `recovering`, and any attempt outside it;
  - each recovery RPC refuses while a write is held open;
- the recovery runs end to end on a scratch workspace:
  - every block id is kept, and every derived id resolves;
  - moved, deleted and undeleted rows return to the point's state;
  - a hard-deleted row is recreated, including one whose child was moved away;
- a crash between the canary change and the first restored row resumes and completes;
- a device holding the old key prompts instead of quarantining rows. Its pre-recovery backlog, and an undo replay from a second tab, land in the quarantine, not on the server;
- a device whose key was stored by an older build writes normally after updating;
- rows absent from the point end up tombstoned, and decrypt cleanly under the new key on every device;
- a deleted synthesized definition is not re-minted after the re-key.
