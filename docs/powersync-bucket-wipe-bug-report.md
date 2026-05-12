# Bucket checksum mismatch on every few user edits → deleteBucket → full re-sync

**SDK:** `@powersync/web@1.38.0` / `@powersync/common@1.53.0` (latest stable as of report).
**Service:** PowerSync Cloud, Stable channel, "Use latest version" enabled (so v1.20.5, current Stable as of 2026-05-11).
**Backend:** Supabase Postgres replication; `client_auth: supabase: true`.
**Rust sync client** (the only option from `@powersync/common@1.53.0`).

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

1. Anything obvious wrong with the config or usage pattern we should check first?
2. Is there a way (debug log, server endpoint) to surface the *server-side* expected-bucket op list at the moment of mismatch so we can diff against local `ps_oplog`?
3. Are there known cases where the Rust client's `add` checksum can be zero while the server's bucket manifest declares a non-zero add component?
4. Happy to provide our instance ID, sync-config, or a live repro account if useful.

## Logs / artifacts available

- Full debug-level js-logger output from a wipe sequence (we capture into a ring buffer via `setHandler` on the global js-logger)
- `ps_buckets` / `ps_oplog` row counts before and after a wipe
- The full elimination matrix's raw data is in the project's commit history if helpful
