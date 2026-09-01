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

### Measurements

**Reads, through the real app** (`db.getAll` of a 50-block page query, 5 trials per page
load, median of trial medians, dev-sized 461-block database):

| concurrent reads | `OPFSCoopSyncVFS` | `OPFSWriteAheadVFS` + 1 reader |
|---|---|---|
| 1 (serial) | 3.0ms | 1.9ms |
| 10 | 20.5ms | 10.8ms |
| 40 | 57.4ms | 30.9ms |

About 2x, which is what one extra connection should buy, and the direction held across
all three shapes. Trial-to-trial spread on a database this small is wide (±50% within a
single page load), and single runs disagreed with each other until the trial count went
up — so read 2x as the size of the effect, not a precise figure. **This needs re-running
on a production-sized database** before anyone quotes a number.

**Writes, two raw wa-sqlite workers on one file:**

| | `OPFSCoopSyncVFS` | `OPFSWriteAheadVFS` |
|---|---|---|
| 1 writer, 1 idle connection | p50 2.0ms | p50 1.5ms |
| 2 sustained writers | p50 1.7–2.6ms, max 58.9ms | p50 1.0–1.2ms, max 34.2ms |
| bursty alternation (idle between writes) | p50 8.0–9.9ms | p50 4.0–4.1ms |

### On the multi-tab stall (#255) — unresolved

[#255](https://github.com/Stvad/knowledge-medium/issues/255) reports ~1s stalls with two
tabs, and Vlad confirms they happen **on Chrome**, not only Firefox. This harness does
not reproduce them: the worst shape it finds is the bursty one above, where CoopSync
costs ~2.4x, not 1000ms. So the harness is missing something the real app has — treat
the stall as open, and do not claim this VFS fixes it or that it doesn't.

The background-throttling hypothesis was tested and did **not** hold. `LOCK_NOTIFY_INTERVAL`
is a 1s `setInterval` plus a `setTimeout(0)` immediate notify, so a hidden tab whose
timers Chrome throttles looked like the obvious candidate. Two real tabs, both hidden,
alternating one write every 1.5s on CoopSync: p50 10ms, max 16ms over ~50 writes. No
stall.

So three harnesses of increasing realism — two workers sustained, two workers bursty,
two hidden tabs at human cadence — all fail to produce it, which is evidence that the
hand-off notify race named as the root cause is **not sufficient on its own** on Chrome.
What none of them have is the real app: a multi-GB database, PowerSync's own sync worker
writing concurrently, the shared sync worker, and real transaction sizes. The next
measurement worth making is on the live client with its real database, not in another
synthetic harness — and until then, nobody should claim this VFS fixes that issue.

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
