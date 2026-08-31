# OPFSWriteAheadVFS on Chromium

> **Status:** current — last verified against code 2026-08-31 (the measurements below were taken that day on Chrome 148, `@powersync/web@1.38.4` / `@journeyapps/wa-sqlite@1.7.0`).

Chromium implements `createSyncAccessHandle({mode: 'readwrite-unsafe'})`, which lets
several connections hold handles on one OPFS file at once. `OPFSWriteAheadVFS` is the
only wa-sqlite VFS that uses it, and the only one PowerSync will open read-only
connections against. This document records what was measured before switching to it,
because two of the findings are silent-data-loss shapes that no `integrity_check`
reports.

Firefox and Safari do not implement that mode, so they stay on `OPFSCoopSyncVFS`. The
choice is made per device by a capability probe, not by user-agent — see
`src/data/localDbVfs.ts`.

## What the switch buys

**A read pool.** `WASQLiteOpenFactory` accepts `additionalReaders`, which it honours
*only* for this VFS: each reader is its own worker and its own read-only connection, and
`readLock` races the writer against the reader pool, taking whichever frees up first.
Before this, every read queued behind every write on PowerSync's single
`DatabaseClient` — a documented single-connection pool. This is the main reason to
switch; it is a client-architecture win, not a VFS micro-benchmark win.

**Somewhat faster writes.** Measured with two workers on one file, 40 small write
transactions each:

| | `OPFSCoopSyncVFS` | `OPFSWriteAheadVFS` |
|---|---|---|
| 1 writer, 1 idle connection | p50 2.0ms, max 5.6ms | p50 1.0ms, max 2.2ms |
| 2 concurrent writers | p50 1.8ms, max 77.8ms | p50 1.0ms, max 44.7ms |
| writer + concurrent reader | writes p50 1.8ms / reads p50 0.2ms | writes p50 1.0ms / reads p50 0.0ms |

Note what this does *not* show: the ~1s multi-tab stalls in
[#255](https://github.com/Stvad/knowledge-medium/issues/255) did not reproduce on
Chrome. That report is Firefox, where the exclusive-handle hand-off is forced and this
VFS cannot help. Do not sell the switch as fixing #255.

## The file format is compatible; the state outside the file is not

The main `.db` is an ordinary SQLite file under both VFSes — same path, same page size,
and each opens a database the other created. `journal_mode` reads as `delete` under
both: `OPFSWriteAheadVFS` implements write-ahead logging *inside the VFS*, invisible to
SQLite, in two sidecar files (`<db>-wa0`, `<db>-wa1`, alternated WAL2-style, bounded
around 4 MB each by its `journalSizeLimit`). Switching is therefore not a data
migration — but each direction has a way to lose data silently:

**Downgrade without a checkpoint loses the tail.** Committed transactions live in the
sidecars until checkpointed. Measured: 1000 rows written under CoopSync, 500 more under
write-ahead, then reopened with CoopSync → **1000 rows, `integrity_check` ok**. The main
file is an intact, older database. `PRAGMA wal_checkpoint=truncate` first, and all 1500
are there.

**Leaving the sidecars behind loses the other side.** A checkpoint does not empty the
files. Measured: after checkpointing, CoopSync wrote row 1501 into the main file;
reopening with write-ahead replayed the stale log and showed **1500 rows,
`integrity_check` ok** — the newer write masked, and any subsequent checkpoint would
have overwritten it for good. So the sidecars must be deleted, not merely checkpointed.

**A hot journal is invisible to the write-ahead VFS.** Its `xAccess` only reports files
it already has open, so SQLite never learns that `<db>-journal` exists and opens a
database that still needs rolling back. Measured by planting a junk `-journal`: the open
succeeded and ignored it. CoopSync does honour it, so the upgrade path opens and closes
once under CoopSync when the journal is non-empty. (A zero-byte `-journal` is the normal
residue of a clean CoopSync close and means nothing.)

`prepareLocalDbForVfs` in `src/data/localDbVfs.ts` is all three of these. Verified
end-to-end on a real app database (write-ahead → coop-sync → write-ahead): sidecars
removed, main file grew by the checkpointed pages, a row written under write-ahead
survived both hops.

## Mixed-version tabs fail to open; they do not corrupt

During a rollout (or a revert) one tab can be on the old code and another on the new,
with the same file. Measured: an exclusive access handle and a `readwrite-unsafe` one
cannot coexist — whichever opens second is refused with `NoModificationAllowedError`.
So the two VFSes can never write the same file concurrently. The failure mode is the
already-tracked "a stale older-version tab holds the OPFS DB and the new one hangs on
Loading" ([#283](https://github.com/Stvad/knowledge-medium/issues/283)),
not data loss.

The same lock is what keeps the downgrade handoff safe with tabs open: it cannot
checkpoint (and so never reaches the sidecar delete) while another tab holds the
database.

## Consequences elsewhere

- **Backups.** `exportRawSqliteDb` copies the main file's bytes, so it now checkpoints
  first — otherwise the download is an intact-looking database missing its most recent
  writes.
- **Wipe / import-replace / forensic inventory.** All three key off one
  `DB_FILE_SIBLING_SUFFIXES` list (`src/data/localDbStorage.ts`), which now includes the
  sidecars. A sidecar surviving a wipe would replay over the next database at that name.
- **Page cache.** PowerSync applies `cache_size` per connection, and a `PRAGMA` executed
  through the app takes the write lock, so it reaches only the writer. The budget is now
  passed to the open factory and divided across connections, keeping the total at the
  previous 256 MiB.

## Rollout

Ship the handoff **before or with** the flip, and revert the flip alone. A revert that
also removes the sidecar handling leaves a Chromium user's `-wa*` files on disk with no
code that knows to checkpoint them — which is the first failure mode above. The
`km.local-db-vfs` localStorage pin (`coop-sync` / `write-ahead`) exists so the flip can
be reverted per device without a deploy; pinning `coop-sync` routes through the full
downgrade handoff.

## Known gap

The recovery zip (`getRawSqliteDbBackup`, used when the database won't open) now bundles
the sidecars, but `importRawSqliteDb` restores a single `.db`. Restoring a zip captured
with outstanding write-ahead frames therefore drops them. Tracked in [#849](https://github.com/Stvad/knowledge-medium/issues/849).
