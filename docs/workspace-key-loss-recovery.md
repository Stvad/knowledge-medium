# Key-loss recovery: re-keying an E2EE workspace in place

> **Status:** design, not built. Last verified against code: 2026-10-19, against master `ebbecd5ad5` (which has #1292, #1293 and #1294 merged). Code wins where they differ.
> Tracking: #1302, under epic #1295. Its issue holds the requirements this design answers; [§12](#12-requirements-and-where-this-design-differs) maps each one to a section and names the three places this design departs from them.

## 1. Goal

A workspace's key is lost: no device holds it and no saved copy survives. Recovery brings the workspace back **from its newest recovery point, under a new key, in place**:

- every block id survives, so every `((id))`, ref property, backlink and URL keeps working, and no id is ever free for another caller to claim;
- the content, tree, timestamps and authorship become exactly the recovery point's;
- attachments are rebuilt under the new key.

**It's point-in-time, not lossless.** Everything written after the recovery point is lost, because nothing else holds that plaintext. The flow says so, with the point's time, before it starts.

It applies to **any** e2ee workspace with a recovery point, whether it was converted (`docs/workspace-e2ee-conversion.md`) or created e2ee. A recovery point is one of:

- **a step-14 point** (conversion runbook step 14): a folder taken on an unlocked device, holding `blocks.jsonl` read from the server and opened under the key, the plaintext of every media block, and a manifest;
- **the conversion's recovery bundle** (conversion §6.3 step 3), which has the same three parts plus some it doesn't need.

A raw SQLite export is not a recovery point, and neither is a device database ([§11](#11-alternatives-considered)).

Non-goals:

- routine key rotation;
- recovering anything newer than the point;
- recovering with other clients active. The conversion's single-client contract (conversion §3) applies unchanged: one device, one tab, every other device closed. The design makes breaking it fail closed where that's cheap.

## 2. Shape

Recovery is the conversion run again, with a recovery point as the plaintext source, under a new key. It reuses the conversion's pieces:

| Conversion piece | What recovery does with it |
|---|---|
| `workspace_conversions` and its phase (#1294) | adds a third phase, `recovering` |
| the flip's admit and lock order | the re-key RPC takes both unchanged |
| the gate that reads the phase (#1293) | treats `recovering` like `sealing` |
| the re-seal engine (#1292) | runs it with the point as its `PlaintextSource`, widened to whole rows |
| the attachment cleaner (#1291) | runs it under the new key, with the point's bytes as its source |
| the one-way pin upgrade (#1293) | becomes the one place any device stores a workspace key |

Two things are new, because no conversion piece covers them:

- **a fence on every block write**: the server refuses a write sealed under a superseded key, or a restore write from a superseded attempt ([§3.2](#32-the-write-fence));
- **key adoption on every device**: quarantine the stale backlog, clear undo, store the new key without losing the old one, and re-materialize authoritatively ([§6.3](#63-adoption)).

The run, on the owner's device:

```
verify point → mint key → rekey_workspace → begin_recovery_attempt → restore → equality pass → attachments → finish_recovery → adopt
                (pending)   phase → recovering   token                                                         phase → none / cleaning
```

## 3. Server

One migration, on top of #1294's.

### 3.1 State

- **`workspaces.wk_generation integer not null default 0`.** Counts re-keys. `create_workspace` and the flip leave it at 0. Only `rekey_workspace` changes it, by +1 in the same statement that replaces `wk_canary`. `workspaces_prevent_e2ee_field_change` guards it alongside the mode and the canary, so no client writes it. It is added to the synced `workspaces` columns (`gen-sync-config.ts`, `workspaceSchema.ts`), so a device always holds a canary and its generation from one checkpoint.
- **`workspace_conversions.phase` admits `recovering`.** The row means what it already means: a server fact that the workspace is mid-change and no device may treat it as ready.
- **Three nullable columns on `workspace_conversions`,** set only while the phase is `recovering`:
  - `recovery_attempt uuid`: the current attempt's token ([§3.2](#32-the-write-fence));
  - `recovery_point text`: the sha256 of the manifest that attempt restores from, so any of the owner's devices can tell which point a resume continues ([§4.5](#45-resume));
  - `return_phase text`: `cleaning` when the recovery interrupted a conversion's cleanup, else null ([§3.3](#33-rpcs)).

  Members can read them under the existing RLS policy. The token is a fence, not a secret: a member who copies it gains only what writing garbage envelopes already gives them today.

### 3.2 The write fence

**Why it's needed.** No envelope names the key that sealed it: `enc:v1:` is the prefix plus nonce and ciphertext (`src/sync/crypto/envelope.ts`), and `blocks_require_ciphertext_for_e2ee` checks the shape only. So after a re-key, the server would accept a write sealed under the lost key from a device that hasn't heard yet, or a request that was simply delayed past the re-key. Either would put an unreadable row back over the restore.

**What a write carries.** Each element of `apply_block_patches` and `apply_block_creates` may carry two more wire-only keys, exactly as patches already carry `base_updated_at`:

- `wk_generation`: the generation of the key the device sealed it under. It's stamped when the write is sealed, at send time, from the key record ([§6.1](#61-key-records));
- `recovery_attempt`: only on a recovery's own restore writes.

Each RPC publishes them to transaction-local settings (`km.write_wk_generation`, `km.write_recovery_attempt`) right before the statement for that element, and clears them right after, as `apply_block_patches` already does for `km.patch_base_updated_at` (`20260803000000_add_patch_base_version_drift_bump.sql`). A value that isn't well-formed reads as absent. A create's insert-or-touch is one statement, so its touch carries the same stamp.

**What the server checks.** `blocks_require_ciphertext_for_e2ee` stays the one owner of the e2ee write rule. It already refuses a row in an e2ee workspace that isn't sealed. It now also refuses:

- **a stale key**, SQLSTATE `23K01`, for a row in an e2ee workspace: a stamp that differs from `wk_generation`, or no stamp once `wk_generation > 0`. A missing stamp passes while the generation is 0, so builds that don't stamp keep working in every workspace that was never re-keyed;
- **a stale attempt**, SQLSTATE `23K02`, for any row: a `recovery_attempt` that isn't the row's workspace's live one, with absent equal only to absent. So while an attempt is live, only its own writes land. Once it's over, a delayed restore write is refused. A non-e2ee workspace never has a live attempt, so any write to one that carries an attempt is refused, which is what keeps a restore write off another workspace's row whatever that workspace's mode.

Both codes are class 23, which `classifyUploadError` treats as permanent. A refused device write therefore goes to the rejection quarantine (`ps_crud_rejected`), user-visible and retryable, through the path refusals already take. That's the right outcome: a write sealed under a dead key can never succeed as sent.

**Why it's atomic.** The trigger reads `wk_generation` and the attempt without a lock, as it reads the mode today. Every RPC that changes either takes `LOCK TABLE blocks IN SHARE MODE NOWAIT` last, as the flip does ([§3.3](#33-rpcs)). So no block write is in flight when the change commits, and every later write sees it.

**What it doesn't cover.** A `DELETE` on `blocks` doesn't fire the trigger. Clients never delete (there's no delete upload trigger, `clientSchema.ts`), and the final equality pass recreates any row deleted before it ([§4.4](#44-completion)). Storage uploads aren't fenced either. An old-key object lands at an old-`K_id` path that no block's address derives to any more, so it's harmless junk ([§5](#5-attachments)).

### 3.3 RPCs

All three are owner-only SECURITY DEFINER functions granted to `authenticated`, with the conversion's refusal codes: `KMC01` for refusals, `55P03` when writes are in flight. Each takes its locks in the flip's order:

1. the `workspaces` row, `FOR NO KEY UPDATE NOWAIT`;
2. then the `workspace_conversions` row, if one exists, `FOR UPDATE NOWAIT`;
3. then `LOCK TABLE blocks IN SHARE MODE NOWAIT`, **last**.

A refusal that needs no lock is decided before them.

**`rekey_workspace(ws, canary, expected_generation)`** replaces the key.

- It refuses unless:
  - the caller owns `ws`;
  - `canary` is an `enc:v1:` envelope;
  - the mode is `e2ee`;
  - `wk_generation = expected_generation`.

  The last check makes the re-key compare-and-set. Two owner devices can't both re-key and leave the first one's saved key silently dead.
- It's admitted by the flip's mechanism: `current_user = 'postgres'` and a transaction-local `km.rekey = ws` that only it sets. `workspaces_prevent_e2ee_field_change` admits exactly `e2ee → e2ee` with a new well-formed canary and `wk_generation = old + 1`.
- Its phase transition depends on the phase it finds:

  | Phase found | After |
  |---|---|
  | none | `recovering` (row inserted, `return_phase` null) |
  | `cleaning` | `recovering`, `return_phase = 'cleaning'` |
  | `recovering` | `recovering` (the new key was lost too; `return_phase` kept) |
  | `sealing` | `sealing`. That row already gates every device, and the conversion still owes its purge ([§7](#7-key-loss-during-sealing)) |

  In every case it clears `recovery_attempt` and `recovery_point`.
- It changes no block. It gives an owner nothing `delete_workspace` doesn't already.

**`begin_recovery_attempt(ws, point_manifest_sha256) returns uuid`.**

- It refuses unless the phase is `recovering`.
- It sets a fresh `recovery_attempt` and the point's manifest hash, and returns the token.
- **Every run calls it**, a resume included, with the same point or a different one. Each run re-checks every row ([§4.4](#44-completion)), so a fresh token costs nothing. It also kills every earlier run's in-flight writes, from this device or another one, which makes a second owner device a clean takeover rather than a race.

**`finish_recovery(ws, attempt)`.**

- It refuses unless the phase is `recovering` and `attempt` is current.
- It then returns the phase to `return_phase`:
  - `cleaning`: the conversion's cleanup resumes under the new key, through #1293's existing offer to finish;
  - null: the row is deleted.
- The table lock means no restore write is in flight when the token dies.

`purge_workspace_history` and `finish_conversion` already refuse any phase but their own, so neither can run during `recovering`.

## 4. The restore

The engine is #1292's `resealWorkspace`: server pages by id, a `PlaintextSource` per page, seal, open-check, send through `apply_block_patches`. Recovery needs four changes to it, and nothing parallel to it.

### 4.1 The point, verified and bound

Before anything irreversible, and again on every resume, since the folder may have changed:

- every part's sha256 matches its manifest entry;
- `blocks.jsonl` has exactly the manifest's block count, with no id repeated. Every row the point lacks is tombstoned, so a truncated file must never pass;
- **binding:** the manifest's workspace id, and every row's `workspace_id`, equal the target. `apply_block_patches` addresses rows by global id, so a point from another workspace would otherwise tombstone every target row and could patch the other workspace's rows with ciphertext sealed for the wrong one. The attempt fence ([§3.2](#32-the-write-fence)) refuses that second case on the server as well, since no other workspace has this attempt live;
- every media block in it has its `attachments/` entry whose bytes hash to its name, or is on the point's no-server-copy list ([§5](#5-attachments)).

The point is then indexed once: id → line offset in `blocks.jsonl`. The restore reads rows by offset through the folder handle, so the order of the server's `ORDER BY id` never has to match the file's.

### 4.2 The expected row

For each server row, the **expected row** is one of two things:

- **The point's row, if the point has it.** That means its three content columns as plaintext, plus `parent_id`, `order_key`, `deleted`, `created_at`, `user_updated_at`, `created_by` and `updated_by`. So moves, reorders, deletes and undeletes since the point are undone too. **Never `updated_at`:** it's the row version. The clamp floors it at the old value and bumps it on a content change, and it must advance so every device takes the restored value.
- **The tombstone form, if the point lacks it.** The row was created after the point. Its content is `''`, `'{}'` and `'[]'`, sealed **under the new key**, and `deleted` is true. Its other columns are left as they are. The content is re-sealed rather than left alone, so that a device that still has the row live can open the tombstone and apply it.

A point row the server lacks was hard-deleted after the point, which only happens outside the app; the history trigger records it. It's **recreated** under the same id ([§4.3](#43-writes)).

### 4.3 Writes

All of them go through the existing RPCs, called directly, as the re-seal does. Every one is stamped with the new `wk_generation` and the attempt token.

- **A differing row:** one `apply_block_patches` element. It carries the expected content sealed under the new key (`encodeForWire`, opened back before sending, as today), the expected metadata columns, and `base_updated_at` from the server row just read. It never carries `updated_at` or `workspace_id`.
- **A recreated row:** `apply_block_creates`, with the point's row sealed under the new key. Recreates go parents before children, by `parent_id` within the recreated set. If the id exists in another workspace, the create's touch hits that row and is refused: by RLS if the owner isn't a writer there, and otherwise by the attempt fence. Either way the restore stops and names the id.
- A `P0002` (the row vanished between read and patch) re-reads, and the next pass recreates it.

**Engine changes**, in `src/sync/conversion/`:

1. `readBlockPage` and `readBlocks` select every column, not just the content ones.
2. A `SealTarget` may carry the expected metadata columns, which go into its patch.
3. `ConversionServer` gains `applyBlockCreates`.
4. Every call takes the stamps.

The conversion's own re-seal keeps sending no stamp: at generation 0 that's admitted, and after a re-key it must not be ([§7](#7-key-loss-during-sealing)).

### 4.4 Completion

A row counts as restored only when **both** of these hold:

- its content columns open under the new key to the expected plaintext. This uses `opensTo`, which compares values, not just whether they open: opening alone proves only which key sealed a value;
- every expected metadata column is equal.

The restore runs as passes over the whole workspace. A pass reads every server row, writes the ones that differ, and then recreates the point's ids it never saw. **The restore is done after a pass that writes nothing and saw every one of the point's ids.** That covers a row changed or deleted behind an earlier pass. Each pass also ends with the engine's existing count check (`requireWholeWorkspace`), so a lost session that reads as an empty table can't pass.

A row that still differs after being written twice is refused, as verify's `unrepaired` is. The clamp can cause that: it rewrites a `created_at` or `user_updated_at` later than server time. A point's rows were clamped when they were written, so a valid point can't hold one.

### 4.5 Resume

The restore keeps no local state: **the server's rows are the progress**. A resume runs the passes again. A row that's already equal costs one read and one open. The progress view counts equal rows over the total.

The point is found the way the conversion finds its bundle. This device keeps a **recovery record**: the point's directory handle and manifest hash. On a resume:

1. If the record's hash equals the server's `recovery_point`, the flow re-opens that folder and re-verifies it ([§4.1](#41-the-point-verified-and-bound)).
2. Otherwise it asks the user to pick a point. If the pick differs from `recovery_point`, it shows both export times and asks for confirmation. Switching is safe, because the new attempt re-checks every row against the new point, so the result is never a mix of two points. But an older point loses more.

Either way the run calls `begin_recovery_attempt` before writing.

## 5. Attachments

Recovery runs #1291's cleaner, under the new key, as a **standalone run**: with no bundle record, even on a device that holds one. One parameter changes. **Its byte source is the point's `attachments/`, plus this device's byte store**, where the conversion passes its bundle. So #1291 has to take its byte source as a parameter, as #1292 does its plaintext source.

What the pass does under the new key follows from its classification rule, unchanged:

- **Every keyed object from the old key reads as *neither*.** A standalone run reports *neither* and never deletes it. **Objects under the old `K_id` are therefore kept**, as are old key records ([§6.1](#61-key-records)), in case the old key turns up.
  - The conversion's own *neither* deletion touches only paths its bundle record archived (`other-objects/`). Those were listed right after the flip, before any keyed object existed. An old-`K_id` path could match one only by a hash collision.
- **Every media block's object at its new keyed path** (`HMAC(K_id_new, hash)`, derived at use time by `deriveObjectKey`, #1309) is missing. So the proof rebuilds each one from the point's bytes: seal, upload, verify with the shared helper.
- **Raw objects** an old client left are converted as usual.

**The proof** is the conversion's, with one input carried forward: **the no-server-copy list**. Each recovery point's manifest carries the conversion's list, copied into each step-14 point, and the proof treats both of its kinds the same way the conversion's does:

- an *archived* (oversized) block expects no Storage object;
- an *absent* one is reported as unrecoverable.

The terminal outcome is the same too: **passed, with these blocks unrecoverable**. The flow lists them, and `finish_recovery` follows the user's confirmation. Without the carried list, a workspace that finished its conversion with such a block could never take a valid recovery point.

Media block ids don't change. Re-capturing a file after recovery mints a second block, because its id hashes the content key under the new `K_id` ([§8](#8-derived-ids-across-a-k_id-change)). That's accepted.

## 6. Devices

### 6.1 Key records

`WorkspaceKeyStore` keeps one record per (user, workspace), and `put` overwrites it. Recovery needs three changes:

- **The record carries `generation`**, the `wk_generation` of the canary its key was validated against. Records without it read as 0. The connector stamps writes from it ([§3.2](#32-the-write-fence)). Canary and generation always come from one source: the server read, or the synced row, which carries both from one checkpoint.
- **A pending slot** per (user, workspace) holds a key the recovery flow minted, revealed, retyped and stored after a probe write, **before** `rekey_workspace`. That's the conversion's key step, aimed at a slot nothing seals with. So the device's current key is untouched until adoption ([§6.3](#63-adoption)), and a crash after the RPC finds the new key here.
- **An archive slot** per (user, workspace, generation). Storing a key never overwrites a record: the current one is copied to the archive first. The archive is never read by the app, only kept.

### 6.2 Entry, and a changed canary

Today an e2ee pin with a usable key record enters `ready` with no network read (`resolveWorkspaceEntry`). So a device still holding the old key would open, and every restored row would fail to decrypt.

**Entry check.** For an e2ee pin with a key, entry reads the server: #1293's single statement (`fetchWorkspaceConversionState`), extended with `wk_generation`, with a timeout of a few seconds rather than its 10. Then:

| Server read | Entry |
|---|---|
| phase `recovering` | locked, `recovering`: the gate's closed state, as for `sealing`. On the owner's devices it offers to resume the recovery |
| the key doesn't open the server canary | locked, `key-replaced`: prompt for the new key, then adopt ([§6.3](#63-adoption)) |
| otherwise | `ready` |
| `unavailable` (offline, timeout) | decide from the **synced** canary: `key-replaced` if the key doesn't open it, else `ready` |
| `not-visible` | as today |

Offline entry stays possible, which it must, since this runs on every e2ee workspace open. Opening offline with a stale key can't harm the restore: rows that arrive later fail to decrypt and heal at adoption, and writes are refused by the fence ([§3.2](#32-the-write-fence)).

On devices whose pin isn't e2ee, #1293's gate already reads the phase. It gains one value: `parseConversionPhase` parses `recovering`, and `checkServerE2eeEntry` returns its closed state for it. An older build reads the unknown value as `sealing`, which is also closed.

**A changed canary.** Every tab watches the synced `wk_canary` of the workspaces this device has pinned e2ee. When it changes:

- the tab drops its own undo and redo stacks for that workspace. The undo stacks are per tab and in memory (`Repo.undoManagers`), so each tab clears its own;
- if the workspace is active, the tab re-resolves entry.

A tab that was open across the recovery broke the single-client contract. This is how it still fails closed.

### 6.3 Adoption

**Adoption is the one place a device makes a key current for an existing workspace**, and the only thing that promotes a pending key. It's #1293's one-way pin upgrade, generalized. Four paths reach it:

- the `key-replaced` gate;
- the key-required gate (an e2ee pin whose record was evicted);
- #1293's pin upgrade on a device that deferred through a conversion;
- the recovering device itself, after `finish_recovery`.

In order:

1. **Check:** read the server (or the synced row when it's unavailable). The phase must not be `sealing` or `recovering`, and the key must open the canary. That gives the generation.
2. **Quarantine the backlog,** if `wk_generation > 0` and this device's current record doesn't already open this canary. Every `ps_crud` transaction holding a write for the workspace moves to `ps_crud_rejected` (with any other writes in the same transaction, as a refusal moves them), where the existing dialog shows it with **Retry**. `ps_crud` is durable, and uploads are sealed at send time, so this device's pre-recovery edits would otherwise go out under the new key, pass the fence, and overwrite the restore. The uploader can't race this move: until step 5 the device can't seal for the workspace under the current key (it holds the old one, which the fence refuses, or none, or its pin still holds uploads).
3. **Clear undo:** drop the workspace's undo and redo stacks with `beginHistoryDropInWriteLock` and `finish`, and tell the user, as `propertyDefinitionSynthesis.ts` does. They hold pre-recovery snapshots, and a replay would also pass the fence.
4. **Marker:** write the existing pin-upgrade marker.
5. **Store:** archive the current record (if any), then put `{wk, K_id, generation}`. On the recovering device this promotes the pending record.
6. **Pin:** set it, or upgrade it to e2ee.
7. **Re-materialize authoritatively:** `drainWorkspace(ws, 'all')`.
8. **Clear the marker.**

**Why the order matters.** Step 2 runs before step 5. Until the key is stored, the device's key doesn't open the canary, so a crash anywhere before step 5 re-enters this path from the gate, and step 2 is idempotent. Once step 5 is done, startup's existing `resumePinUpgrade` finishes steps 6 to 8 from the marker, with the same authoritative drain. If the crash fell between steps 4 and 5, the resume runs with whatever key the device had, old or none. Entry then reads the server as usual ([§6.2](#62-entry-and-a-changed-canary)), finds the key doesn't open the canary, and comes back here. That's also why `resumePinUpgrade` can stay local even though a recovery can now begin after its marker was written: entry, not the resume, checks the server.

**What step 2 doesn't do.** It doesn't try to tell a stale backlog from a fresh one: a device never records which generation a queued write was made under. A device adopting a key it didn't hold, in a workspace that has been re-keyed, can't show its backlog is newer than the re-key, so all of it is quarantined. That over-quarantines in rare cases, such as a key evicted after the recovery. A quarantined write is retryable.

**Why step 7 must be authoritative.** The disk side already is. The drain skips only ids still in `ps_crud`, and step 2 emptied that for the workspace (`reconcile.ts`). The in-memory cache isn't. `BlockCache.applyIfNewer` drops a sync snapshot strictly older than the cached one. A quarantined local edit can carry a local-clock `updated_at` above the restored row's, which is the server's version +1, so the UI would keep showing the pre-recovery row. The next edit would then be built from it.

So the adoption drain writes the cache unconditionally (`setSnapshot`) for every row it writes. That's one flag on `drainWorkspace`. `'all'` also re-tries every row that failed to decrypt while the device held the old key.

**Accepted:** a block this device created and never uploaded stays live locally after its create is quarantined, as any quarantined create does today. **Retry** creates it under the new key.

### 6.4 Writes

The connector's `encryptUploadOps` already seals at send time with the current record's key. It now also stamps that record's `generation` on each create and patch. Nothing else changes in the upload path:

- **No client-side pre-send fence and no hold.** A device that seals under a dead key is refused by the server and quarantined, which is the same end state, reached atomically ([§11](#11-alternatives-considered)).
- **A device without the key** (e2ee pin, record evicted) behaves as today. `requireCek` throws and the write stays queued until adoption.

## 7. Key loss during sealing

The re-key is admitted while the phase is `sealing`, and the phase stays `sealing`. The conversion's flow (#1290) then branches on `wk_generation`. At 0 it runs as designed. **Above 0, a re-key happened during sealing, so it replaces re-seal and verify with the restore**:

| Server shows | Phase |
|---|---|
| `sealing`, `wk_generation = 0` | bundle → re-seal → verify → purge (unchanged) |
| `sealing`, `wk_generation > 0` | bundle → **restore from the bundle** ([§4](#4-the-restore)) → purge |

Why that's sound:

- **The bundle is a complete plaintext copy.** Nothing but the re-seal writes during `sealing`. If the bundle is lost too, it's re-taken without a key: unsealed rows are read verbatim, and sealed rows from the `before_diff` of their latest plaintext-to-envelope history row. A restore write over a row the re-seal had sealed goes from envelope to envelope, so it never counts as that record. One over a row still plaintext does count, and its `before_diff` is that same plaintext. #1290's record finder must judge by shape alone, since the key that sealed the earlier records is the lost one.
- **The restore needs no tombstones or recreates** against a bundle that's current. If it ever writes a metadata column, the bundle was stale, and the purge refuses with `KMC02`. The conversion's existing answer to that is to re-take the bundle.
- **Its equality pass stands in for verify.** Verify's records were sealed under the lost key and can't be opened.
- **The purge then runs as usual**, with `through` and the count from the bundle's verified manifest. The restore's history rows are `U` rows that change only content columns and `updated_at`, writing envelopes, so `is_reseal_history_row` accepts them.
- **No attempt token is needed.** Every attempt restores the same values, since every bundle is a copy of the same state: a re-taken one differs only after a write outside the re-seal, which the single-client contract excludes and the purge refuses with `KMC02`. So mixing two attempts' writes is harmless. The generation fence refuses the old key's re-seal batches still in flight: they carry no stamp, and the generation is now above 0. #1292's engine needs no change for that.

Re-keying before the first re-sealed row takes the same branch. It's equivalent there, because every row still equals the bundle.

The new key stays in the pending slot until adoption, as in [§9](#9-the-flow), so the conversion's flow looks for the workspace key in the pending slot first. Its step-7 pin upgrade is that adoption, with `wk_generation > 0`, so the converting device's held writes are quarantined, not uploaded. That's conservative, and they're retryable.

## 8. Derived ids across a `K_id` change

`K_id` is `HKDF(WK, 'km/asset-content-key/v1')` (`src/sync/crypto/contentKey.ts`), so a new key moves every namespace derived from it. The rotation note in `src/sync/crypto/derivedIdNamespace.ts` names the two consumers.

**Synthesized property definitions.** Their ids are `derivedBlockId` under `deriveWorkspaceIdNamespace(K_id, 'km/property-definition-ns/v1')`. Re-iding them is out, because field rows point at definition ids. The two cases behave differently:

- **A live definition survives.** Synthesis asks who holds the *name* (`nameHolding`, over live rows), finds the old-id definition, and converges.
- **A deleted one would come back.** A deletion is honoured only through `classifyOccupant` at the *derived id*. The tombstone sits at the old id, the new id reads `absent`, and the pass mints. That breaks "a deletion is an instruction".

**The rule.** When the key record's `generation > 0`, synthesis also looks for a **deleted** definition block that stores the candidate's name, at any id in the workspace. If there is one, it skips the key with the same reason the tombstone verdict gives.

- **Where it goes:** after the `held` branch, so a live holder still converges, and before `classifyOccupant`.
- **Its query:** a tombstone-inclusive sibling of `tx.livePropertyDefinitionNames`.
- **Why the name is still there:** a restored deletion keeps its content, because soft-deleted rows do. Recovery's own tombstones carry empty content, so a definition created after the point never blocks a re-mint. That's right, since the point never had it.

The comment that `K_id` "is immutable until rotation exists" in `propertyDefinitionSynthesis.ts` becomes: it changes only through recovery, behind the gate. A gesture that a canary change interrupts mints under the old namespace, sealed under the old key, so the fence refuses it.

**Media blocks.** Their ids hash `${ws}:${contentKey}`, and in e2ee the content key is `HMAC(K_id, sha256)`. Existing ids don't change, and their paths derive at use time. A re-capture mints a duplicate block, which is accepted.

## 9. The flow

One guarded in-app flow on the owner's device. It holds `navigator.locks` per (user, workspace), re-confirms the single-client contract on every run, and reads the server directly, as the conversion's flow does.

**0. Preflight.** It refuses unless all of these hold:

- the user owns the workspace;
- it's e2ee;
- the phase isn't `sealing` (that's [§7](#7-key-loss-during-sealing), inside the conversion's flow);
- the key store is durable;
- the File System Access API is available.

The user picks a point. It's verified ([§4.1](#41-the-point-verified-and-bound)), its export time is shown with "everything after this is lost", and the user confirms.

**1. Key.** If the pending slot holds a key, the run reuses it. Otherwise it mints one: generate, derive `K_id`, mint the canary, re-parse the **displayed** string, reveal it once, have it retyped, probe-write, store as pending.

**2. Re-key.** `rekey_workspace(ws, canary, generation read in step 0)`. A `55P03` retries with backoff. If the server canary is already the pending key's, an earlier run got this far, and the step is skipped.

**3. Attempt.** `begin_recovery_attempt(ws, manifest sha256)` returns the token.

**4. Restore** ([§4](#4-the-restore)), with a progress view and a wake lock.

**5. Attachments** ([§5](#5-attachments)).

**6. Finish.** `finish_recovery(ws, token)`.

**7. Adopt** on this device ([§6.3](#63-adoption)).

**8. Done.** The report says:

- old key records and old-`K_id` objects were kept;
- other devices will prompt for the new key and quarantine their pre-recovery backlog;
- **take a new step-14 point now**, since every older point predates the new key.

**Resume.** Every run starts from what the server shows:

| Server shows | This device | Next |
|---|---|---|
| no `recovering` row, canary opens under the pending key | | step 7. Finish already ran, or the phase returned to `cleaning`, whose own offer then appears |
| no `recovering` row, canary doesn't | | step 0 (pending kept: the user saved it) |
| `recovering`, canary opens under the pending key | | step 3 |
| `recovering`, canary opens under no key here | owner | ask for the new key, store it as pending, then step 3. If that key is lost too, step 1: re-keying again is admitted |
| `recovering` | not the owner | the gate's closed state |

**Who builds what.** The steps above, and the step-14 "take a recovery point" gesture, are #1302's. The gesture reuses #1290's folder writer and verifier.

## 10. Fleet gate

Conversion runbook step 1 requires #1302's client half on **every** device before the first production conversion. With the server fence, **that is no longer needed for safety**. A build without the client half fails closed in a re-keyed workspace:

- **Holding the old key:** restored rows fail to decrypt, and its local rows stay as they were. Its writes carry no stamp, or a stale one, so they're refused and quarantined.
- **Holding the new key** (a fresh device the user unlocked): it can't hold a pre-recovery backlog, and its unstamped writes are refused until it updates.
- **Deferring through a conversion:** its pin upgrade sends unstamped writes, which are refused.

Updating any of them heals it through adoption. What remains is the safety net itself: #1302's server half and its flow must exist before the first conversion (runbook step 1's last bullet). Relaxing runbook step 1 is open question 1.

## 11. Alternatives considered

- **A client-side pre-send fence in the connector**, holding a workspace's uploads until its key opens the server's canary. Not built: it isn't atomic with the write, so the server fence is needed anyway, and once the server refuses, the client check adds nothing. Its `hold` would also cost more than a refusal. While anything sits in `ps_crud`, `ps_crud_hold_downloads` stops this device's downloads for **every** workspace, whereas a refusal moves the write to the quarantine at once.
- **A key generation stored on each block row.** Rejected: `apply_block_patches` keeps any column a patch omits, so an old client's patch would inherit the row's current stamp and pass.
- **A fingerprint of the canary as the stamp, instead of a counter.** Rejected: compatibility still needs a "never re-keyed" bit to let unstamped writes through, and a counter is that bit plus an order.
- **One token per point rather than per run.** Rejected: a per-run token also fences a crashed run's late writes from the same point, and makes a second device a clean takeover.
- **Reusing `sealing` as the recovery phase.** Rejected: the purge would accept it. A distinct phase keeps every conversion RPC refusing during recovery.
- **Finishing recovery to no row always.** Rejected when the recovery interrupted `cleaning`: the conversion's cleaner still has archived objects to delete and a proof to pass, and only the `cleaning` phase brings its offer back.
- **Deferring materialization when the key doesn't open the synced canary.** Not needed. Rows that fail to decrypt are re-tried by adoption's `'all'` drain. Gating on the synced canary would also make adoption wait for sync to deliver the new canary.
- **Restoring from a device database, or through the PowerSync queue.** Rejected for the conversion's reasons (conversion §12): a device holds only what it downloaded, and the queue would need the pin first and push every row through one FIFO.
- **Delete and same-id restore.** Rejected in the conversion doc: ids would be free across the gap.

## 12. Requirements, and where this design differs

Every requirement in #1302 is met. Three are met differently from how the issue words them:

| Requirement in #1302 | Where |
|---|---|
| owner-only re-key, the flip's admit and lock order, new key stored first | [§3.3](#33-rpcs), [§6.1](#61-key-records) |
| whole-row restore, tombstones under the new key, completion by equality | [§4.2](#42-the-expected-row)–[§4.4](#44-completion) |
| recreate hard-deleted rows; refuse a foreign id | [§4.3](#43-writes) |
| bind and verify the point; restore only from its `blocks.jsonl` | [§4.1](#41-the-point-verified-and-bound) |
| attachments rebuilt; old objects and key records kept; no-server-copy list carried | [§5](#5-attachments), [§6.1](#61-key-records) |
| entry checks the key against the server canary, and on a synced canary change | [§6.2](#62-entry-and-a-changed-canary) |
| server fence on old-key writes | [§3.2](#32-the-write-fence) |
| per-attempt token, invalidated by finish | [§3.2](#32-the-write-fence), [§3.3](#33-rpcs) |
| quarantine before storing the key; undo clear; rematerialize | [§6.3](#63-adoption) |
| phase transitions; gate every device for the whole recovery | [§3.3](#33-rpcs), [§6.2](#62-entry-and-a-changed-canary) |
| synthesized-definition tombstones survive | [§8](#8-derived-ids-across-a-k_id-change) |
| key loss during `sealing` | [§7](#7-key-loss-during-sealing) |
| **differs:** fence uploads at the connector | not built. The server fence plus class-23 quarantine replaces it ([§11](#11-alternatives-considered)) |
| **differs:** finishing → no row | → no row, or back to `cleaning` when recovery interrupted it ([§3.3](#33-rpcs)) |
| **differs:** fleet gate before the first conversion | not needed for safety ([§10](#10-fleet-gate)); open question 1 |

## 13. Open questions

1. **Relax conversion runbook step 1?** Recommendation: yes. #1302's server half and flow must exist before the first conversion; its client half need not be on every device ([§10](#10-fleet-gate)). This changes the conversion doc, so it waits for a yes.
2. **The synthesis rule's scope.** Recommendation: only re-keyed workspaces (`generation > 0`), as [§8](#8-derived-ids-across-a-k_id-change) says. Applying it everywhere would also honour a deleted *hand-made* definition of the same name, which may be right, but it changes behaviour for every workspace and is its own decision.
3. **Over-quarantine on adoption.** A device that held no key, or another key, quarantines its whole backlog for a re-keyed workspace. That includes a deferring device after a `sealing` re-key, where nothing was rolled back. Recommendation: accept; it's retryable, and telling a stale write from a fresh one needs a write-time generation in every queued write.
4. **Local-only rows of quarantined creates** stay live on the device after adoption ([§6.3](#63-adoption)), as they do today. Recommendation: accept, rather than delete rows on a device whose quarantine still holds them.

## 14. Tracking

| Piece | Where |
|---|---|
| Migration: `wk_generation` (synced), the `recovering` phase and its three columns, the fence in `blocks_require_ciphertext_for_e2ee`, the stamp keys in both write RPCs, the three RPCs, pgTAP | #1302 |
| Engine: whole-row targets, wide reads, creates, stamps, the restore passes | #1302, on #1292's module |
| Key store: `generation`, pending and archive slots | #1302 |
| Entry check, canary watcher, the `recovering` gate state | #1302, on #1293's gate |
| Adoption: backlog quarantine, undo clear, authoritative drain | #1302, generalizing #1293's pin upgrade |
| Connector stamping | #1302 |
| Synthesis rule | #1302 |
| Byte source as a parameter of the cleaner | #1291 |
| Sealing branch; key-free record finder for the re-taken bundle; the folder writer and verifier | #1290 |
| The recovery flow, and the step-14 point gesture | #1302 |

**Done when** (from #1302, plus the fence):

- pgTAP pins:
  - the re-key refuses non-owners, plaintext rows, calls outside the admit, and a stale `expected_generation`;
  - the fence refuses a stale or missing stamp once re-keyed, and a stale or foreign attempt;
  - each recovery RPC refuses while a write is held open;
- the recovery runs end to end on a scratch workspace:
  - every block id is kept, and every derived id resolves;
  - moved, deleted and undeleted rows return to the point's state;
  - a hard-deleted row is recreated;
- a crash between the canary change and the first restored row resumes and completes;
- a device holding the old key prompts instead of quarantining rows, and its pre-recovery backlog lands in the quarantine, not on the server;
- rows absent from the point end up tombstoned, and decrypt cleanly under the new key on every device;
- a deleted synthesized definition is not re-minted after the re-key.
