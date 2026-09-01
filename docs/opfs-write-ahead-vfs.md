# OPFSWriteAheadVFS on Chromium

> **Status:** current — last verified against code 2026-08-31. Measurements taken that day on Chrome 148, `@powersync/web@1.38.4` / `@journeyapps/wa-sqlite@1.7.0`, against a 2 GB / 350k-block copy of a production database.

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

Re-run on a **2 GB production database** (350,472 blocks, imported into a dev origin),
querying the app's hottest read — a parent's child ids — through `repo.db`, 5 trials per
page load, median of trial medians:

| concurrent reads | `OPFSCoopSyncVFS` | `OPFSWriteAheadVFS` + 1 reader |
|---|---|---|
| 1 (serial) | 0.4ms | 0.2ms |
| 10 | 3.7ms | 1.0ms |
| 40 | 8.9ms | 4.2ms |

About 2x, which is what one extra connection should buy, and at this scale the trials
are tight (c40 spread 3.7–7.6ms vs 7.9–9.2ms) rather than the ±50% seen on a 461-block
dev database, where single runs disagreed with each other until the trial count went up.

Raw per-query cost is unchanged — one connection reading sequentially through wa-sqlite
measures p50 0.20ms under both VFSes at 2 GB. The win is entirely the removal of
queueing on PowerSync's single connection, which is what `additionalReaders` buys.

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

## The move is one-way

The main `.db` is byte-compatible — either VFS opens a file the other created,
same page size, `journal_mode` reads as `delete` under both. So this is not a data
migration. What is not shared is the state *outside* that file, and **both directions
of a switch can lose data silently, with `PRAGMA integrity_check` reporting `ok`**:

- **Opening a write-ahead database with CoopSync** reads the main file as an intact,
  older database. Measured: 1000 rows written under CoopSync + 500 under write-ahead,
  reopened with CoopSync → 1000 rows.
- **Leaving stale sidecars next to a CoopSync database** replays that log over
  whatever CoopSync wrote in between. Measured: after a checkpoint, CoopSync wrote row
  1501; reopening with write-ahead showed 1500.

The design answer is to make the move **one-way and to let the sidecars be the
record of it**:

```
sidecars exist → write-ahead        (outranks the pin and the probe both)
no sidecars    → probe: supported ? write-ahead : CoopSync
```

A database moves to write-ahead and stays there. Nothing here moves one back, so the
first failure above cannot arise and the second has nothing to leave behind. The only
preparation left is the third hazard: **the write-ahead VFS never sees a hot rollback
journal** (its `xAccess` reports only files it already has open), so when one is
present CoopSync opens and closes once to clear it first.

This replaced an automatic downgrade path — checkpoint the log, verify it drained,
delete the sidecars, and refuse if any step could not be proven. That path was correct
but it was the source of most of this change's review findings, because it ran silently
at boot on the only copy of the user's data and every edge needed its own guard. Moving
a database back is now a deliberate operation, not something a failed probe can
trigger.

A browser that loses the capability with sidecars on disk therefore fails to open,
loudly, rather than degrading. Accepted: it needs a shipped API to be withdrawn.

## Mixed-version tabs, running at the same time, fail to open rather than corrupt

During a rollout (or a revert) one tab can be on the old code and another on the new,
with the same file. Measured: an exclusive access handle and a `readwrite-unsafe` one
cannot coexist — whichever opens second is refused with `NoModificationAllowedError`.
So the two VFSes can never write the same file concurrently. The failure mode is the
already-tracked "a stale older-version tab holds the OPFS DB and the new one hangs on
Loading" ([#283](https://github.com/Stvad/knowledge-medium/issues/283)), not data loss.

This says nothing about the SEQUENTIAL case, which is the dangerous one: an old-build
client alone with a write-ahead database acquires the handle uncontested and reads the
stale main file. Nothing at the OPFS layer prevents that — only not shipping a build
that would do it (see Rollout).

**Accepted residual, same window.** The hot-journal check in `prepareLocalDbForVfs` is
not atomic with the open that follows it. During a mixed-version rollout an old CoopSync
tab could, in the gap, take the handle, begin a write, and be killed — leaving a hot
journal that the write-ahead open then ignores by design, over partially written pages.
Closing this needs cross-context exclusion held from the check through PowerSync's open,
and there is no primitive for that: any handle we hold to bridge the gap is one the open
itself cannot acquire. It is accepted rather than guarded because it needs an old build
running concurrently, writing, and dying inside a millisecond window — and it disappears
entirely once no pre-flip build is live.

## Consequences elsewhere

- **Backups.** `exportRawSqliteDb` copies the main file's bytes, so it now checkpoints
  first — otherwise the download is an intact-looking database missing its most recent
  writes.
- **Wipe / import-replace / preview sweep / forensic inventory.** Backup and the
  forensic inventory take the whole `DB_FILE_SIBLING_SUFFIXES` list
  (`src/data/dbFileSiblings.ts`), but the deleting paths split it, and the two halves
  have OPPOSITE orders for the same reason:

  - **Wipe and the preview sweep** remove SQLite's journals first, then the main file,
    then the sidecars best-effort. A log that outlives its `.db` is inert — the VFS
    truncates both when it opens a `.db` that does not exist — whereas deleting a log
    while its `.db` survives strips committed frames from a database the caller is then
    told was left intact.
  - **Import** removes the sidecars and journals first, then the old `.db`, and only
    then writes the replacement. Here a new `.db` *is* written afterwards, so a
    surviving log would find a file to replay onto; and dropping the old `.db` before
    the write means a failed import leaves no database rather than the previous one
    silently short of the log just deleted.
- **Page cache.** PowerSync applies `cache_size` per connection, and a `PRAGMA` executed
  through the app takes the write lock, so it reaches only the writer. The budget is now
  passed to the open factory and divided across connections, keeping the total at the
  previous 256 MiB.

## Rollout

Reverting the feature means "stop moving new databases", not "move them back":
databases already on write-ahead stay there, and the `km.local-db-vfs` pin
(`coop-sync` / `write-ahead`) only affects databases that have not moved yet — it is
ignored for one that has, because honouring it would be exactly the first failure mode
above.

**A plain `git revert` of this change is NOT that, and is unsafe.** It removes
`resolveLocalDbVfs` along with everything else, so a reverted client opens every
database with CoopSync unconditionally — including ones that already have sidecars,
which is failure mode one on the spot. A revert has to KEEP the sidecar branch and
drop only the probe-driven move. Ship the sibling-file handling
(`DB_FILE_SIBLING_SUFFIXES`, including the service worker's preview sweep) before or
with the flip for the same reason: a `-wa*` file that survives a wipe replays over the
next database of that name.

## Moving a database back, by hand

There is deliberately no automatic path, so write this down rather than rediscovering
it. With the app closed in every other tab: pin `km.local-db-vfs` to `coop-sync`,
export a backup (the export checkpoints first, so the `.db` it writes is complete),
reset the local database, then import that backup. The pin then applies, because the
restored file has no sidecars.

Note that a sidecar counts by EXISTENCE, not size. The VFS creates both on every open
and removes neither on close, so an interrupted open can leave zero-byte sidecars that
pin a database to write-ahead just as firmly as full ones.

## Known gap

The recovery zip (`getRawSqliteDbBackup`, used when the database won't open) now bundles
the sidecars, but `importRawSqliteDb` restores a single `.db`. Restoring a zip captured
with outstanding write-ahead frames therefore drops them. Tracked in [#849](https://github.com/Stvad/knowledge-medium/issues/849).
