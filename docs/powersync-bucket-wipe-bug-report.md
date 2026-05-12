# Bucket checksum mismatch on every few user edits → deleteBucket → full re-sync

**SDK:** `@powersync/web@1.38.0` / `@powersync/common@1.53.0` (latest stable as of report).
**Service:** PowerSync Cloud, Stable channel, "Use latest version" enabled (so v1.20.5, current Stable as of 2026-05-11).
**Backend:** Supabase Postgres replication; `client_auth: supabase: true`.
**Rust sync client** (the only option from `@powersync/common@1.53.0`).
**Our repo (open source):** https://github.com/Stvad/knowledge-medium — concrete file links below.

## Related (read first)

- **[powersync-js#674](https://github.com/powersync-ja/powersync-js/issues/674)** — open since 2025-07, same backend (Supabase), same checkpoint-apply failure class, but the reporter's recovery is "about a second or less" and "everything stays in sync." Our case is worse: every 1–3 echoes the local checksum mismatches the server's expected checksum and PowerSync issues `deleteBucket`, forcing a full bucket re-download.
- **[powersync-service#584](https://github.com/powersync-ja/powersync-service/issues/584)** — closed, different trigger (client-side priority override on a server-default-priority stream). Documents the same `0x00000000 = 0x00000000 (op) + 0x00000000 (add)` symptom that we hit on ~40% of our wipes (2 of 5 samples below). The maintainer's response noted the server announces priority-0 then sends `partial_checkpoint_complete` before bucket data arrives. We use *only* default-priority auto_subscribe streams with no client overrides, so the specific trigger doesn't apply — but if the underlying "validate before data arrives" mechanism has another trigger path, this might be related.

## Summary

Every 1–3 user edits to a synced row, the Rust sync client logs:

```
Could not apply checkpoint, Checksums didn't match,
failed for: <bucket> (expected 0x..., got 0x... = 0x... (op) + 0x... (add))
```

…immediately follows that with `deleteBucket`, and then re-downloads the *entire* bucket on the next checkpoint. On a 350k-op bucket this consumes hundreds of MB per wipe and breaks the user's offline-edit experience because every edit cycle full-re-syncs.

## Reproduction recipe

1. Provision a fresh Supabase + PowerSync Cloud project (`edition: 3` sync rules with a partition parameter).
2. Add `@powersync/web@1.38.0` and connect with `OPFSCoopSyncVFS` + `enableMultiTabs: true`.
3. Sync a workspace (any size — see "Doesn't matter" below).
4. Type into any synced row 5–6 times with 1–2 s pauses between edits.
5. Observe: ~30% of echoes (the server's 1-op write-checkpoint response for your own edit) fail validation with the checksum-mismatch message above, then trigger a full bucket re-download.

We see this every test run, on every account.

## Sample checksum-mismatch lines

From a fresh user (`bdea6caa…`), fresh workspace (`b0869034…`), bucket `5#blocks|0["<wsid>"]`, server-side `versioned_bucket_ids = 5`, multi-stream config:

```
expected 0xe2cde968, got 0x35a03eea = 0x35a03eea (op) + 0x00000000 (add)
expected 0xc07c5560, got 0x427510b4 = 0x95476636 (op) + 0xad2daa7e (add)
```

Earlier samples from a different fresh user (`ef8ab141…`), bucket `4#workspace_data|0["<wsid>"]` (single-stream config):

```
expected 0x8a55a3f6, got 0xea1146c7 = 0xea1146c7 (op) + 0x00000000 (add)
expected 0xe9e57ca3, got 0xd1bd05cb = 0x3178a89c (op) + 0xa0445d2f (add)
expected 0xad3b1a2a, got 0x48694fac = 0x72287646 (op) + 0xd640d966 (add)
```

**Note**: in 2 of 5 samples the `add` component is `0x00000000` while the server expects non-zero. May or may not be informative — flagging in case it narrows where in the Rust client to look.

## Timeline of one wipe (debug log)

```
dt=-1439 ms  PATCH <block-id> [content, updated_at]    ← user edit (CRUD upload queued)
dt= -647     Upload complete, no write checkpoint needed.
dt= -565     Validated and applied checkpoint           ← echo applied cleanly
dt= -464     PATCH <block-id> [content, updated_at]    ← next user edit
dt= -300     Upload complete, no write checkpoint needed.
dt= -205     ⚠ Could not apply checkpoint, Checksums didn't match (expected …, got … = … (op) + … (add))
             → triggers deleteBucket → full re-download with totalOps = bucket count
```

Sometimes the wipe takes ~5 s between the failed apply and the new checkpoint arriving (the client is stuck at `downloadedOps=0 / totalOps=1` during that window). Sometimes it's immediate.

## What we eliminated

| Variable | Tested | Effect |
|---|---|---|
| Storage backend (OPFSCoopSync vs IDBBatchAtomic) | both | both reproduce |
| `enableMultiTabs` (true vs false) | both | both reproduce |
| Workspace size (40 ops vs 350k ops) | both | both reproduce; rate of wipes similar |
| Browser (Chrome 147 vs Firefox 151, incognito + regular) | both | both reproduce |
| SDK (1.37.2 vs 1.38.0) | both | both reproduce |
| Upload batching (per-row PATCH vs batched UPSERT) | both | both reproduce |
| User (existing vs brand-new with no history) | both | both reproduce |
| Sync-rules shape (single stream with `with:` subquery vs 3 streams with JOIN auth) | both | both reproduce |
| `versioned_bucket_ids` (4 vs 5 after redeploy) | both | both reproduce |
| Service version | current Stable (Use-latest-on) | reproduces |

Our app code does **not** touch `ps_oplog` / `ps_buckets` / `ps_kv` / `powersync_*` virtual functions outside of standard upload triggers writing to `ps_crud`. `db.connect()` is called once per user (memoized + lock-serialized). No row-event handler writes back into synced tables on sync-applied rows.

## Answering "are there async triggers?" (the question on #674)

In response to https://github.com/powersync-ja/powersync-js/issues/674#issuecomment-… the maintainer asked whether triggers might cause asynchronous subsequent writes. For our setup:

- **Server-side (Supabase)**: one trigger on `public.blocks` (`blocks_clamp_updated_at`) that clamps a future `updated_at` to `NOW()` — synchronous, pre-write, doesn't generate additional rows or async work. Standard Postgres trigger semantics.
- **Client-side (SQLite)**: thirteen triggers, all defined in [`src/data/internals/clientSchema.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/internals/clientSchema.ts) — `row_events`, `block_aliases`, `block_types` maintenance triggers that write to *separate side tables* (never back into `blocks`); upload-routing triggers gated on `(SELECT source FROM tx_context WHERE id = 1) = 'user'` so they only fire on user txs, not on sync-applied writes. The audit comment in that file documents the gating with reasoning.
- **No async fan-out**: the row_events table is consumed by a separate `rowEventsTail` worker that only invalidates React subscriptions / updates an in-memory cache — it does not write back into any synced table. See [`src/data/internals/rowEventsTail.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/internals/rowEventsTail.ts).

## Code links (open source)

- Sync rules: [`powersync/sync-config.yaml`](https://github.com/Stvad/knowledge-medium/blob/master/powersync/sync-config.yaml)
- Sync rules generator (also useful for the column list): [`scripts/gen-sync-config.ts`](https://github.com/Stvad/knowledge-medium/blob/master/scripts/gen-sync-config.ts)
- PowerSync connector (`fetchCredentials` + `uploadData`): [`src/services/powersync.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/services/powersync.ts)
- DB / connector setup (PowerSyncDatabase construction, logger setup, VFS, flags): [`src/data/repoProvider.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/repoProvider.ts)
- Schema + raw-table definitions (BLOCKS_RAW_TABLE.put with the no-op WHERE guard discussed below): [`src/data/blockSchema.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/blockSchema.ts)
- All client-side SQLite triggers, including the upload-routing trigger gated on `tx_context.source = 'user'`: [`src/data/internals/clientSchema.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/internals/clientSchema.ts)
- Tx engine (where `tx_context.source` is set and cleared inside the writeTransaction): [`src/data/internals/commitPipeline.ts`](https://github.com/Stvad/knowledge-medium/blob/master/src/data/internals/commitPipeline.ts)

## Our config (relevant fragments)

`sync-config.yaml` (current shape):

```yaml
config:
  edition: 3
streams:
  workspace_data:
    auto_subscribe: true
    with:
      user_workspaces: |
        SELECT workspace_id
        FROM public.workspace_members
        WHERE user_id = auth.user_id()
    queries:
      - SELECT workspaces.id, … FROM public.workspaces WHERE workspaces.id IN user_workspaces
      - SELECT workspace_members.id, … FROM public.workspace_members WHERE workspace_members.workspace_id IN user_workspaces
      - SELECT blocks.id, …, blocks.deleted FROM public.blocks WHERE blocks.workspace_id IN user_workspaces
```

We re-tested with a multi-stream config (three independent streams, JOIN-based auth) instead of the single stream with `with:` binding — the wipes reproduce identically, so this isn't the [GHSA-q6wc-xx4m-92fj](https://advisories.gitlab.com/pkg/npm/@powersync/service-sync-rules/GHSA-q6wc-xx4m-92fj/) subquery-filter pattern.

Client-side: PowerSync's raw-tables are configured for `blocks`, `workspaces`, `workspace_members`. The `blocks` raw-table `put` uses
`INSERT INTO blocks (…) VALUES (…) ON CONFLICT(id) DO UPDATE SET … WHERE <any col differs>` — i.e. the UPDATE is skipped when the incoming row is byte-identical to the local one. We considered whether this no-op could trip checkpoint validation; the bug also reproduces on workspace ops where no app-side WHERE-guard logic is involved, so this isn't the cause.

## Asks

1. Could this be the same underlying mechanism as #674 with a different surface (full re-sync vs. one-off warning that recovers in a second)?
2. Is there a way (debug log, server endpoint) to surface the *server-side* expected-bucket op list at the moment of mismatch so we can diff against local `ps_oplog`?
3. Are there known cases where the Rust client's `add` checksum can be zero while the server's bucket manifest declares a non-zero add component? (#584 documents one such case but the trigger doesn't apply to us.)
4. Anything obvious in our open-source code (linked above) that's wrong?
5. Happy to provide our PowerSync instance ID, sync-config, or a live repro account if useful — let us know how to share privately.

## Logs / artifacts available

- Full debug-level js-logger output from a wipe sequence (we capture into a ring buffer via `setHandler` on the global js-logger)
- `ps_buckets` / `ps_oplog` row counts before and after a wipe
- The full elimination matrix's raw data is in the project's commit history if helpful
