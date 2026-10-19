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
| the re-seal engine's `PlaintextSource` seam (#1292) | supplies the point, widened to whole rows, with verify's read-back |
| the bundle's folder writer and verifier (#1290) | verify every point; write step-14 points |
| the attachment cleaner (#1291) | runs it under the new key, with the point as its input |
| the one-way pin upgrade (#1293) | becomes **adoption**, the one place a device makes a key current for an existing workspace |

Two things are new, because no conversion piece covers them:

- **a fence on every block write.** Each write carries the key generation its writer was looking at when it made the write. The server refuses a stale one, and a restore write from a superseded attempt ([§3.2](#32-the-write-fence));
- **adoption's wait.** A device doesn't admit edits under the new key until it has synced past the recovery ([§6.3](#63-entry-and-adoption)).

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

**What the server checks.** `blocks_require_ciphertext_for_e2ee` stays the one owner of the e2ee write rule. On top of "every content column is sealed", it refuses with SQLSTATE `23K01`, giving a message that says which rule failed:

- **a stale generation**, for a row in an e2ee workspace: a stamp that differs from `wk_generation`, or no stamp once `wk_generation > 0`. A missing stamp passes while the generation is 0, so builds that don't stamp keep working in every workspace that was never re-keyed;
- **the wrong attempt.**
  - While the workspace's phase is `recovering`, only a write carrying its live `recovery_attempt` lands, and none lands while no attempt is live.
  - Outside `recovering`, a write carrying any attempt is refused. A workspace that isn't e2ee is never `recovering`, so that also keeps a delayed restore write, or one aimed at another workspace's row, from landing.

**How it reads its inputs.** The conversion row is read through a SECURITY DEFINER helper, so the check never depends on the writer's RLS. It's read only for a row in an e2ee workspace, or for a write that carries an attempt.

**Who it skips.** Writes made as `postgres` are exempt: migrations and their backfills. Every client write runs as `authenticated`, both write RPCs are SECURITY INVOKER, and no SECURITY DEFINER function writes `blocks`. A `service_role` maintenance script must publish the stamp.

`23K01` is class 23, which `classifyUploadError` treats as permanent. A refused device write therefore goes to the rejection quarantine (`ps_crud_rejected`), user-visible and retryable, through the path refusals already take.

**Why it's atomic.** The trigger reads the generation and the attempt without a lock, as it reads the mode today. Every RPC that changes either takes `LOCK TABLE blocks IN SHARE MODE NOWAIT` last, as the flip does ([§3.3](#33-rpcs)). So no block write is in flight when the change commits, and every later write sees it.

**What it doesn't cover.**

- **A `DELETE` on `blocks`** doesn't fire the trigger. Clients never delete (there's no delete upload trigger in `clientSchema.ts`). The restore ends by counting the workspace's rows ([§4.3](#43-order-of-work)), so a delete during the restore fails that count and the run resumes. One after the restore is out of scope, as any operator delete is.
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
- The server runs no check of its own. Two things make the attempt's last check final:
  - while the attempt is live, only its own writes land, and it has awaited every write it sent;
  - the table lock means none of its writes is still in flight when the token dies.

`purge_workspace_history` and `finish_conversion` already refuse any phase but their own. So neither can run during `recovering`, a delayed purge from before a sealing re-key included.

## 4. The restore

The restore is #1292's `resealWorkspace`, given the `PlaintextSource` that #1292 left for recovery (`src/sync/conversion/reseal.ts`). A test there already seals over rows sealed under another key. For each page of server rows, by id, the recovery source returns only the rows that differ from their **expected row** ([§4.2](#42-the-expected-row)), with that expected row's values.

`resealWorkspace` already checks the key against the canary first, which is now the new key's, and counts the workspace's rows last. Recovery adds three things to it:

- a target carries the expected metadata columns into its patch, not only content;
- every sent page is read back and compared, as verify does with `readBlocks`;
- every call carries the generation and attempt stamps.

### 4.1 The point, verified and bound

The point is verified by #1290's bundle verifier (conversion §6.3 step 3), before anything irreversible and again on every resume, since the folder may have changed:

- the part hashes;
- no repeated id;
- **binding**: the manifest's workspace id, and every row's `workspace_id`, equal the target. A point from another workspace would otherwise tombstone every target row, and try to recreate that workspace's ids here, which the attempt fence also refuses on the server;
- every media block has its `attachments/` entry, or its hash is on the manifest's list of hashes with no verified source.

Two checks differ from the bundle's:

- **The row count** is checked against the manifest's block count, not the server's, since the server has moved on. Every row the point lacks is tombstoned, so a truncated file must never pass.
- **The manifest's `properties_migration`** must equal the workspace's current state. The switch is forward-only, so rows from an earlier stage would read wrong (open question 2). The bundle records it at the flip, and the conversion and the switch never overlap (conversion runbook step 7), so it can't move during `sealing`.

The point is then indexed once, mapping each id to its line offset in `blocks.jsonl`. Rows are read by offset through the folder handle, so the order of the server's `ORDER BY id` never has to match the file's.

### 4.2 The expected row

For each server row, the expected row is one of two things:

- **The point's row, if it has one.** That means its three content columns as plaintext, plus `parent_id`, `order_key`, `deleted`, `created_at`, `user_updated_at`, `created_by` and `updated_by`. So moves, reorders, deletes and undeletes since the point are undone too.
  - **Never `updated_at`.** It's the row version: the clamp floors it at the old value and bumps it on a content change, so a restored row's version always advances.
- **The tombstone form, if it doesn't.** The row was created after the point. Its content is `''`, `'{}'` and `'[]'` sealed **under the new key**, and `deleted` is true; its other columns are left as they are. The content is re-sealed so that a device still holding the row live can open the tombstone and apply it.

### 4.3 Order of work

Each attempt runs three steps, all stamped with the new generation and the attempt token:

1. **Recreate.** Page the server's ids only. Any point id the server lacks was hard-deleted after the point; that only happens outside the app, and the history trigger records it.
   - Recreate them through `apply_block_creates`, with the point's row sealed under the new key. `updated_at` is the flow's clock, which the clamp caps.
   - **One row per call, parents first.** Recreates are rare, and a call is one transaction, so a refused row in a shared call would roll back its siblings without saying which one failed. Parents go first because `blocks_workspace_id_parent_id_fkey` is checked at each call's commit.
   - **A parent cycle** among the recreates has no parents-first order, so its rows go in one call. The key is checked at commit.
   - **An id that exists in another workspace** can't be recreated. The create's touch is refused, by RLS (`42501`) or by the other workspace's attempt rule (`23K01`). That id and its point descendants go on the **unrestored** list ([§4.4](#44-completion)).
   - **A `23K01` naming this workspace's attempt** means another run took over, so this run stops.
2. **Check and repair:** the source's pass ([§4](#4-the-restore)). A differing row is sent as one `apply_block_patches` element:
   - its expected content, sealed under the new key and opened back before sending, as today;
   - its expected metadata columns;
   - `base_updated_at` from the server row just read.

   It never carries `updated_at` or `workspace_id`.
   - **A row whose expected parent is on the unrestored list** keeps the server's `parent_id`. Moving it under a parent this workspace lacks would fail the key at commit and roll back its page. It's restored in every other column, and goes on the list too.
   - **A `P0002`** (the row vanished between read and patch) fails the run, which resumes.
3. **Count.** The pass must have seen as many rows as the server counts, which `resealWorkspace` already checks. Recreates happened before it, so they're counted.

The conversion's own re-seal still sends no stamp. At generation 0 that's admitted, and after a re-key it must not be ([§7](#7-key-loss-during-sealing)).

### 4.4 Completion

A row is restored when **both** hold:

- its content columns open under the new key to the expected plaintext (`opensTo`, which compares values, since a value that opens only proves which key sealed it);
- every expected metadata column is equal.

A row still wrong when its page is read back goes on the unrestored list. Verify would refuse the run there (`unrepaired`). Recovery carries on, so the list is complete. The clamp could cause such a row by rewriting a `created_at` or `user_updated_at` later than server time, but a point's rows were clamped when they were written.

While the attempt is live, only its own writes land. So one complete pass with no refusal finishes the restore. A crash, a refusal, a vanished row, or a count that doesn't match makes the next run start over.

**Invariant at the end:** every row of the workspace is sealed under the new key, unrestored ones included. A row on the list still had its content re-sealed. Adoption relies on this ([§6.3](#63-entry-and-adoption)).

**The terminal outcome** mirrors the attachments': **passed, with these rows unrestored**. The list holds:

- ids taken by another workspace, and their point descendants;
- rows kept under their server parent;
- rows still wrong after their repair.

The flow shows the list, and `finish_recovery` follows only the user's confirmation. Without this outcome, one stuck row would keep every device gated.

### 4.5 Resume

The restore keeps no local state: **the server's rows are the progress**. A resume runs the attempt again, and a row already equal costs one read and one open.

This device keeps a **recovery record** for the point, as the conversion keeps its bundle record: the directory handle and the manifest's hash. A resume re-opens that folder and re-verifies it ([§4.1](#41-the-point-verified-and-bound)). On another device, or once the folder is gone, the flow asks the user to pick a point.

Switching points between runs is safe. Each run re-checks every row against its own point, so no row ends up holding values from two points. The one exception is a tombstone: it keeps whatever metadata an earlier run gave the row, which no device shows.

## 5. Attachments

Recovery runs #1291's cleaner under the new key, as a **standalone run**: with no bundle record, even on a device that holds one. Its inputs come from the point, not from this device:

- **the media blocks to prove:** the point's media rows, which after the restore are exactly the server's. This device's database still holds the pre-recovery tree until it adopts ([§6.3](#63-entry-and-adoption)), so it can't be the source.
- **the bytes:** the point's `attachments/`. The point is verified to hold every media block's bytes or list it ([§4.1](#41-the-point-verified-and-bound)). The local byte store doesn't help here, because entries captured after the conversion are named by `HMAC(K_id_old, hash)`, which no lookup under the new `K_id` finds (`deriveObjectKey`).

So #1291's cleaner has to take both as inputs, as #1292's engine takes its plaintext source.

**Not after a sealing re-key.** When `return_phase` is `sealing`, this step is skipped:

- no keyed object exists yet;
- the conversion's own cleaner runs under the new key after the purge;
- a standalone run would delete raw objects that a key-free re-take of the bundle may still need as its byte source.

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

Each tab holds, per workspace, the **generation it entered at**: the synced `wk_generation` when entry let it in ([§6.3](#63-entry-and-adoption)). Everything a tab writes is fenced by that number. The rule that keeps it honest: **a tab never takes a new generation in place.**

**Writes record it.**

- **What carries it.** The engine records the tab's generations in the transaction's context (`tx_context`, which already carries `source` and `tx_seq`). That context is written when the transaction starts, before its workspace is pinned (`checkWorkspace` pins a transaction to one workspace). So it holds a small map by workspace id, and the upload triggers pick the row's workspace's entry.
  - Both upload triggers copy it into the queued write: the insert trigger's create and the update trigger's patch.
  - The connector sends it as the write's stamp, and folding a patch into its create keeps it.
- **What it means.** A write says which workspace its writer was looking at, however late it's sealed or sent. A tab that never pinned the workspace e2ee records none.
- **Compaction keeps the lowest.** When the connector merges one block's patches across transactions (`compactBlockCrudEntries`), the merged write carries the lowest stamp among them, with an absent one lowest of all. That isn't positional, unlike `base_updated_at` in `mergePatchPayloads`. A locked tab still writes UI state, so an old stamp can arrive after a new one. Merged by position, a stale patch's columns would pass the fence under the new stamp.
- **What it covers.** The fence refuses every write a tab made at an old generation ([§3.2](#32-the-write-fence)), whenever it's sent: a backlog, an edit, an undo replay, a debounced commit. It then lands in the quarantine.

**Undo entries record it.** An undo entry records its transaction's generation, and replay refuses an entry from another generation. That holds even for a transaction that started at the old generation and recorded its entry after the stacks were emptied.

**Ids derived from `K_id` check it.** Synthesis and media capture read `K_id` before their transaction. Such a transaction checks, inside itself, that the tab's generation is still the one `K_id` was read under, and refuses otherwise. Without that, a gesture that straddled a generation change would mint old-namespace ids stamped with the new generation.

**Taking a new one tears the workspace down.**

- **When.** A tab watches the synced `wk_generation` of each workspace it has open. When it differs from the tab's, the tab tears the workspace view down, as switching workspaces does. The adoption marker's `storage` event triggers the same.
- **What teardown does.** It flushes pending edits and debounced commits, which carry the old stamp. It drops the workspace's undo and redo stacks and evicts its rows from the in-memory cache.
- **After.** The tab then re-resolves entry, and mounts again at whatever generation entry gives it. No editor buffer, cached row or undo entry from the old generation survives into the new one.

**Retry** in the rejection dialog re-stamps a write with the retrying tab's current generation. That's the user saying "send this now". Retry today re-queues one row of a quarantined transaction at a time. Adoption quarantines whole backlogs, which makes multi-row transactions common, so #1322 tracks re-queuing them whole.

### 6.2 Key records

`WorkspaceKeyStore` keeps one record per (user, workspace), and `put` overwrites it. Recovery adds one field and two slots:

- **`adoptedGeneration`** on the record: the generation at which adoption stored it. Entry is `ready` only when this matches the synced generation ([§6.3](#63-entry-and-adoption)).
  - A record without it reads as 0, not as unknown. Every path that stored one ran a drain: #1293's pin upgrade, or the unlock gate. At generation 0, adoption's own extra steps (5 and 6) do nothing, so re-adopting such a record would only drain again, on every e2ee workspace of every device.
  - This catches a key stored by an older build. That build validates against the synced canary, with no phase check and no drain, so it may have stored the new key mid-recovery, or over local rows the restore later replaced. Such a record goes through adoption once, with no prompt.
  - It's provenance only: stamps come from the synced row ([§6.1](#61-the-tabs-generation)).
- **A pending slot** per (user, workspace). It holds a key the recovery flow minted, revealed, had retyped, and stored after a probe write, all **before** `rekey_workspace`. That's the conversion's key step, aimed at a slot nothing seals with.
  - Only adoption moves it to current, and adoption clears it.
  - The key gate offers a pending key that opens the server canary before prompting for one.
- **An archive** per (user, workspace). Adoption never overwrites a record: it appends the current one to the archive first. The app never reads the archive back; it only keeps it, in case the old key turns up.

### 6.3 Entry and adoption

**Entry** stays local. For an e2ee pin with a key, today's `resolveWorkspaceEntry` returns `ready` with no network read. Now it returns `ready` only when both hold:

- the key opens the **synced** canary;
- the record's `adoptedGeneration` equals the synced generation.

The tab then enters at that generation. Otherwise entry returns `server-e2ee`, the reason #1293 already gives a pin that doesn't match the server. Its gate (`ServerE2eeGate`) reads the live phase on mount:

- **During `recovering`,** it shows the closed state. On the owner's devices it offers to resume the recovery.
- **Otherwise,** it offers adoption: with the stored or pending key if one opens the server canary, without a prompt; else it asks for the key.

`parseConversionPhase` parses `recovering`, and `checkServerE2eeEntry` returns its closed state for it. An older build reads the unknown value as `sealing`, which is also closed.

**Adoption** is #1293's one-way pin upgrade, generalized. It's the one place a device makes a key current for an existing workspace. Three paths reach it:

- the `server-e2ee` gate, for any pin;
- the key-required gate (an e2ee pin whose record was evicted);
- the recovering device itself, after `finish_recovery`.

It holds `navigator.locks` per (user, workspace), so two tabs never run it at once. In order:

1. **Read the server, live.** The phase must be none or `cleaning`, and the key must open the server canary. Call its generation *G*.
   - If the server can't be read, adoption waits: the phase isn't synced, so offline adoption could open a workspace mid-recovery.
   - **The one exception:** a device whose pin is already e2ee, when the synced generation is 0. It may adopt offline from the synced row, skipping step 4, as unlocking a key-required workspace works offline today.
     - **Why the phase can't be wrong there.** An e2ee pin was set past `sealing`, or the workspace was created e2ee. At generation 0 the phase can't be `sealing` again, and can't be `recovering`, since both need a re-key.
     - **If this device missed a re-key,** its synced canary is the old key's. A pasted new key won't open it, and the old key that does is fenced.
     - **A pin upgrade never takes this path.** It needs the live read at any generation, since a conversion still `sealing` is at generation 0 too, as #1293 already requires.
2. **Write the marker** (#1293's pin-upgrade marker).
3. **Store:** append the current record to the archive, put the new one with `adoptedGeneration = G` (clearing the pending slot), and set or upgrade the pin.
4. **Wait for a checkpoint newer than step 1's read:** a PowerSync write checkpoint requested after step 1. That's the mechanism `ps_crud_hold_downloads` already waits on. Once it's applied, the device's synced image holds everything the server held at step 1, which after a recovery is the whole restore. Until then the gate shows that the workspace is downloading.
   - Storing the key first is what unsticks this. Any of the workspace's queued writes that couldn't be sealed now seal, carry their stale stamps, are refused, and leave `ps_crud`.
   - A write held for *another* workspace still stalls downloads. That's the stall #1301 removes, and step 6 waits on it too.
5. **Quarantine what the fence would refuse.** Every queued transaction holding a write for the workspace with a stamp other than *G* (or none, once *G* is above 0) moves to `ps_crud_rejected`.
   - **Why it's needed.** A checkpoint is published only while `ps_crud` is empty, so whatever is left was queued after step 4's checkpoint, by a tab that hadn't torn down yet. The next step skips any row with a queued write, so these would otherwise keep their local values once refused.
   - **How it moves.** Each transaction moves in one write transaction, keyed by `tx_id` as `recordRejectionToTable` keys it, so a concurrent refusal leaves one copy.
   - **At generation 0** nothing moves, so a conversion's held writes still upload after its pin upgrade, as #1293 designed.
6. **Re-materialize once:** `drainWorkspace(ws, 'all')`.
   - When *G* is above 0, it then drops the workspace's local rows that have no staged row and no queued write. Those are creates the server never had: their writes are in the quarantine, where **Retry** re-creates them.
   - A row that still doesn't open stays staged, as #1293's rule has it, and doesn't hold the marker. That can't be a restored row (§4.4's invariant), only garbage a member wrote, which today's quarantine already covers.
7. **Clear the marker**, and tell the user that the workspace's undo history from before the recovery is gone. Every tab, this one included, tears down and re-enters at *G* ([§6.1](#61-the-tabs-generation)).

**Crash and resume.** A crash before step 2 leaves the old key, or none, so the gate re-enters adoption. With the marker set, startup's `resumePinUpgrade` runs. It now first checks the stored key against a live read of the canary:

- **It opens:** re-run steps 3 to 7. Step 3 is idempotent, and it puts back a pin the crash may have left plaintext, which would otherwise hold the uploads step 4 waits on.
- **It doesn't:** the crash came before step 3, so the marker is dropped and the gate appears. It offers the pending key, if there is one.
- **The server can't be read:** the device stays gated, with the marker kept, unless step 1's exception applies.

**Changed invariants.** Two statements stop being true:

- **"The phase only moves forward."** A recovery can now begin after the conversion has finished.
- **"A row means a conversion is in progress."**

The comments that state either one change with this:

- `conversionState.ts`'s header;
- `upgradeWorkspacePin.ts`'s resume ("the phase never moves back");
- `workspaceConversion.ts`'s header;
- the migration's table comment;
- conversion §6.1 and §6.3.

`resumePinUpgrade` can stay free of a phase read because step 1 checks the phase before the marker exists.

## 7. Key loss during sealing

A re-key during `sealing` goes through `recovering`, with `return_phase = 'sealing'`, like any other recovery. The point is the conversion's bundle.

- **The bundle is a complete plaintext copy.** Nothing but the re-seal writes during `sealing`. If it's lost, the recovery flow re-takes it with #1290's taker, without a key, as conversion §6.3 step 3 provides.
  - Unsealed rows are read verbatim.
  - Sealed rows come from the `before_diff` of their latest plaintext-to-envelope history row.
  - A restore write over a row the re-seal had sealed goes from envelope to envelope, so it never counts as that record. One over a row still plaintext does count, and its `before_diff` is that same plaintext.
- **Content only.** While `return_phase` is `sealing`, the restore never sends a create, a tombstone, or a non-content column. Needing one means the bundle is stale: the attempt stops, re-takes the bundle, and starts a new attempt.
  - Content writes sent before the stop are harmless, since a re-take reproduces the same plaintext.
  - So every restore write is a content-only `U` row writing envelopes, which `is_reseal_history_row` accepts. A stale bundle's values are never written, and so never archived as the truth.
- **Attachments wait** for the conversion's own cleaner ([§5](#5-attachments)).
- **Back to the conversion.** `finish_recovery` returns the phase to `sealing`, and the bundle the restore used is the conversion's bundle record. The conversion's flow (#1290) then sees `sealing` with `wk_generation > 0` and skips re-seal and verify:
  - every row is sealed already;
  - verify's records for rows re-sealed before the key loss open only under the lost key;
  - the restore's check stood in for verify.

  It purges with `through` and the count from the bundle's verified manifest.
- **The converting device keeps the new key pending until its step-7 pin upgrade**, which is adoption, since adoption refuses during `sealing`. Until then the conversion's flow finds the key in the pending slot.
- **Held writes are quarantined.** Every device that deferred through the conversion has its held writes quarantined at its pin upgrade, since they carry no stamp and *G* is above 0. #1293 meant them to upload. They were made against the pre-flip workspace that the bundle restores, so they're retryable, but they no longer go out on their own.

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

Both comments in `propertyDefinitionSynthesis.ts` that call `K_id` "immutable until rotation exists" change to: it changes only through recovery, and a mint checks the generation it read `K_id` under ([§6.1](#61-the-tabs-generation)).

**Media blocks.** Their ids hash `${ws}:${contentKey}`, and in e2ee the content key is `HMAC(K_id, sha256)`. Existing ids don't change, and their paths derive at use time. Re-capturing a file after recovery mints a second block, which is accepted.

## 9. The flow

One guarded in-app flow on the owner's device. It holds `navigator.locks` per (user, workspace), re-confirms the single-client contract on every run, and reads the server directly, as the conversion's flow does.

**0. Preflight.** It refuses unless all of these hold:

- the user owns the workspace;
- it's e2ee;
- the key store is durable;
- the File System Access API is available.

The user picks a point. In `sealing`, if the bundle is gone or stale, the flow re-takes it ([§7](#7-key-loss-during-sealing)). The point is verified ([§4.1](#41-the-point-verified-and-bound)), its export time is shown with "everything after this is lost", and the user confirms.

**1. Key.** If the pending slot holds a key, the run reuses it. Otherwise it mints one: generate, derive `K_id`, mint the canary, re-parse the **displayed** string, reveal it once, have it retyped, probe-write, store as pending.

**2. Re-key.** `rekey_workspace(ws, canary, generation read in step 0)`. If the server canary is already the pending key's, an earlier run got this far, and the step is skipped.

**3. Attempt.** `begin_recovery_attempt(ws)` returns the token.

**4. Restore** ([§4](#4-the-restore)), with a progress view and a wake lock.

**5. Attachments** ([§5](#5-attachments)), unless `return_phase` is `sealing`.

**6. Finish.** Confirm any unrestored rows and unrecoverable blocks, then call `finish_recovery(ws, token)`.

**7. Adopt** on this device ([§6.3](#63-entry-and-adoption)). After a `sealing` return, it happens at the conversion's step 7 instead ([§7](#7-key-loss-during-sealing)).

**8. Done.** The report says:

- old key records and old-`K_id` objects were kept;
- undo history from before the recovery is gone;
- other devices will ask for the new key, and their pre-recovery writes will land in the rejection quarantine;
- **take a new step-14 point now**, since every older point predates the new key.

A failed RPC with `55P03` retries; any other failure stops the run, and the next run resumes. Every run starts from what the server shows:

| Server shows | Next |
|---|---|
| `recovering`, canary opens under the pending key | step 3 |
| `recovering`, canary opens under no key here (owner) | ask for the new key, store it as pending, then step 3. If that key is lost too, step 1: re-keying again is admitted |
| `recovering` (not the owner) | the gate's closed state |
| no `recovering` row, canary opens under the pending key | step 7, or the conversion's flow if the phase is `sealing` |
| no `recovering` row, canary opens under the current key | nothing; a marker left behind resumes adoption |
| no `recovering` row, canary opens under neither | step 0. The pending key is kept: the user saved it |

**The step-14 gesture** ("take a recovery point") is #1302's. It reuses #1290's folder writer and verifier, and follows conversion runbook step 14:

- **Rows** come from server pages opened under the key. The paging is bracketed by the bundle's consistency check: the workspace's history count must be the same before and after, or the rows are re-read. Every block write adds a history row, so a file that passes is one instant.
- **Media bytes** come from whichever source verifies.
- **The no-verified-source list** is re-derived when the point is taken.

It refuses to take a point while any row doesn't open, and lists those rows, since the restore needs an expected value for every row. The manifest records:

- the workspace id;
- the block count;
- each part's hash;
- the export time;
- `properties_migration`;
- the hashes with no verified source.

## 10. Fleet gate

Conversion runbook step 1 requires #1302's client half on **every** device before the first production conversion. With the server fence, **that's no longer needed for safety**. A build without the client half fails closed in a re-keyed workspace:

- its writes carry no stamp, so they're refused and quarantined, whatever key it holds and however it got it;
- its restored rows fail to decrypt.

After updating, its record has no `adoptedGeneration`, so entry sends it through adoption once ([§6.2](#62-key-records)). What remains is the safety net itself: #1302's server half and flow must exist before the first conversion (runbook step 1's last bullet). Relaxing runbook step 1 is open question 1.

## 11. Alternatives considered

- **Stamping the generation at send time, from the key record.** That was this doc's first draft, and it breaks in three ways:
  - a pre-recovery backlog or undo replay, sealed after the device stores the new key, would carry the new generation and pass;
  - other tabs would need coordinating;
  - a record stored by an older build, with no generation, would stamp 0 forever.

  Write-time stamping makes "pre-recovery" a property of the write itself.
- **Waiting, in adoption, until every staged row opens under the new key.** One garbage envelope from any member would keep every device gated for good. Waiting for a checkpoint is a sync position, and always ends.
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
| attachments rebuilt; old objects and key records kept | [§5](#5-attachments), [§6.2](#62-key-records) |
| entry checks the key against the canary, and again when it changes | [§6.1](#61-the-tabs-generation), [§6.3](#63-entry-and-adoption) |
| server fence on old-key writes; per-attempt token | [§3.2](#32-the-write-fence), [§3.3](#33-rpcs) |
| quarantine the pre-recovery backlog; clear undo and tell the user; rematerialize before admitting edits | [§6.1](#61-the-tabs-generation), [§6.3](#63-entry-and-adoption) |
| gate every device for the whole recovery | [§3.3](#33-rpcs), [§6.3](#63-entry-and-adoption) |
| synthesized-definition tombstones survive | [§8](#8-derived-ids-across-a-k_id-change) |
| key loss during `sealing` | [§7](#7-key-loss-during-sealing) |

These are met differently from how the issue words them:

| The issue says | This design | Why |
|---|---|---|
| each write carries the key generation it was sealed under | the generation its tab entered at when it **made** the write | [§11](#11-alternatives-considered) |
| fence uploads at the connector | no connector fence | [§11](#11-alternatives-considered) |
| entry reads the server canary, never the synced row alone | entry reads the synced row; adoption reads the server | [§11](#11-alternatives-considered) |
| quarantine the backlog before storing the key | stale writes are identified by their write-time stamp, so the order no longer matters, and the move comes after storing (it unsticks the queue) | [§6.3](#63-entry-and-adoption) |
| finish invalidates the token in the same transaction as the final check | the server runs no check; the attempt fence and the table lock make the last client check final | [§3.3](#33-rpcs) |
| refuse a foreign id; the gate stays until the equality check passes | a confirmed outcome, "passed, with these rows unrestored" | [§4.4](#44-completion) |
| a resume is never a mix of two points | true for every column but a tombstone's metadata, which no device shows | [§4.5](#45-resume) |
| the approved-missing set is copied into every later point; *archived* and *absent* kinds | one list, re-derived when each point is taken, as #1313 revised the conversion | [§5](#5-attachments) |
| `sealing` stays `sealing` | `sealing` → `recovering` → `sealing` | [§11](#11-alternatives-considered) |
| finishing → no row | → the phase recovery interrupted | [§11](#11-alternatives-considered) |
| before the first re-sealed row: re-key and continue the conversion | the same restore path, equivalent there | [§7](#7-key-loss-during-sealing) |
| (from #1293) held writes upload after the pin upgrade | after a sealing re-key they're quarantined, retryable | [§7](#7-key-loss-during-sealing) |
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
| Restore: the recovery `PlaintextSource`, metadata in targets, read-back, recreates, stamps | #1302, on #1292's module |
| Tab generation: `tx_context` map, both upload triggers, compaction, undo entries, the `K_id` check, teardown on change, Retry re-stamp | #1302 |
| Key store: `adoptedGeneration`, pending slot, archive | #1302 |
| Entry check, `recovering` gate state, adoption | #1302, generalizing #1293's gate and pin upgrade |
| Synthesis rule | #1302 |
| The cleaner takes its media set and bytes as inputs | #1291 |
| Bundle manifest records `properties_migration`; the bundle taker callable by recovery; skip re-seal and verify at `wk_generation > 0`; pending-slot lookup; offer to finish on e2ee-pinned owner devices | #1290 |
| The recovery flow, and the step-14 gesture | #1302 |

**Done when** (from #1302, plus the fence):

- pgTAP pins:
  - the re-key refuses non-owners, a plaintext (`none`) workspace, calls outside the admit, and a stale `expected_generation`;
  - a generation-only update is refused;
  - the fence refuses a stale or missing stamp once re-keyed, any write without the live attempt while `recovering`, and any attempt outside it, and admits a write made as `postgres`;
  - each recovery RPC refuses while a write is held open;
- the recovery runs end to end on a scratch workspace:
  - every block id is kept, and every derived id resolves;
  - moved, deleted and undeleted rows return to the point's state;
  - a hard-deleted row is recreated, including one whose child was moved away;
- a crash between the canary change and the first restored row resumes and completes;
- a device holding the old key prompts instead of quarantining rows. Its pre-recovery backlog lands in the quarantine, not on the server, and so does a debounced edit or an undo replay from a second tab open across the adoption;
- a device whose key an older build stored goes through adoption once after updating, and its stale local rows are replaced;
- rows absent from the point end up tombstoned, and decrypt cleanly under the new key on every device;
- a deleted synthesized definition is not re-minted after the re-key.
