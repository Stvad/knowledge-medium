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

Both lines are live as of Deploy 2 (`MOVE_NEW_DATABASES = true`). Before that, only the
`km.local-db-vfs` pin moved a database — so on a build older than Deploy 2, a Chromium
database that has not moved has no failed probe to diagnose, because no probe ran.

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
  - **Import** removes the old `.db` FIRST, then every sibling, and only then writes
    the replacement. Everything must be gone before that write, because a new `.db`
    gives a surviving journal or log something to replay onto — but removing siblings
    while the old database still stands means a failure part-way leaves it short of its
    own committed frames. Main-first makes the failure state "no database", which the
    next open treats as fresh and the user fixes by retrying the import.
- **Page cache.** PowerSync applies `cache_size` per connection, and a `PRAGMA` executed
  through the app takes the write lock, so it reaches only the writer. The budget is now
  passed to the open factory and divided across connections, keeping the total at the
  previous 256 MiB.

## Rollout

Ship this in **two deploys**, with the guard first. The constant is
`MOVE_NEW_DATABASES` in `src/data/localDbVfs.ts`.

**Deploy 1 — read the record, create none** (`MOVE_NEW_DATABASES = false`, shipped in
[#851](https://github.com/Stvad/knowledge-medium/pull/851)). A database that already has
sidecars opens write-ahead, but nothing moves on its own, so behaviour was identical to
before. What it bought is that every build in the field knows what to do if it meets a
moved database. The `km.local-db-vfs=write-ahead` pin opts a single device in, which is
how the rollout starts — run on it against a real database for as long as you want
confidence.

**Deploy 2 — flip the constant** (`MOVE_NEW_DATABASES = true`, shipped in
[#860](https://github.com/Stvad/knowledge-medium/pull/860)). Databases move on next
boot. To back out, set it to `false` again and deploy; do NOT revert the module with
it.

**The transition window, for the record.** A tab still running a pre-flip build resolved
to CoopSync at its own boot, and the service worker deliberately does not reload open
pages (`registerServiceWorker.ts`, and no `clients.claim()` in `sw/worker.ts`) — a new
build reaches a tab only when that tab reloads. So during the rollout a device could
have an abandoned old-build tab while a reloaded tab moved the database; when the new
tab closed, the old one would reacquire the file and read a main file stale relative to
the sidecars.

There was no detecting our way out of it. A new-build tab cannot see an old-build one:
the sync SharedWorker's URL is content-hashed per build so the two do not share one, and
PowerSync's cross-tab locks are held only for the duration of an operation, so an idle
tab holds nothing to query. Announce-and-detect only works between builds that both have
it, which excludes the build being upgraded from.

**The control is still procedural, and it still applies.** The window does not close
because both deploys shipped — it closes per device, when that device's last pre-flip tab
reloads. Until then: close or reload every app tab, on every device. That was a merge
precondition before the flip and it is post-deploy remediation after it; the sequence is
the same either way, and it is why changing the pin is a reload boundary too.

Two things about proportion, which pull in opposite directions and should both be said:

- The comparison is *not* against a healthy baseline. Multi-tab was already degraded
  under CoopSync — [#255](https://github.com/Stvad/knowledge-medium/issues/255)
  (contended writes stalling around a second) and
  [#283](https://github.com/Stvad/knowledge-medium/issues/283) (a stale tab holding the
  file and hanging the next one). "The old tab keeps working" was never the status quo.
- That does **not** mean this VFS fixes those. #255 was never reproduced here (see the
  measurements above, which say so explicitly and say not to claim otherwise) and both
  issues are open. The pre-existing failures were loud — stalls and hangs — whereas the
  transition hazard is silent, which is the one respect in which it is worse.

**The rule this exists to make possible:**

> Once Deploy 2 has run on a device, never serve that device a build older than
> Deploy 1. Reverting the *flip* is safe. Reverting the *branch* is not.

A plain `git revert` of the whole change is the second kind: it removes
`resolveLocalDbVfs` along with everything else, so a reverted client opens every
database with CoopSync unconditionally — including ones that have moved, which is the
first failure mode above.

**Why a stale device is not a problem.** OPFS is per-origin *per-device*, so a database
can only have sidecars if that same device ran a build that creates them. A device that
has not opened the app in months cannot be holding a moved database. The hazard needs
one device to run new code and then older code, which in practice means a rollback — a
deliberate act, which is why a rule can govern it.

**Changing the pin, or flipping the constant, is a reload boundary.** The VFS is
resolved once per tab at boot and held for that tab's lifetime, so a change does not
reach tabs that are already open. That leaves one tab on each VFS, and they cannot
safely share the file: at best the second fails to open (exclusive and
`readwrite-unsafe` handles cannot coexist), and at worst the CoopSync tab — which
releases its handle between transactions by design — reacquires after the write-ahead
tab has gone and reads a main file that is now stale relative to the sidecars it wrote.
Close every tab, then change it, then open one.

## Moving a database back, by hand

There is deliberately no automatic path, so write this down rather than rediscovering
it. With the app closed in every other tab: pin `km.local-db-vfs` to `coop-sync`,
export a backup (the export checkpoints first, so the `.db` it writes is complete),
reset the local database, then import that backup. The pin then applies, because the
restored file has no sidecars.

Note that a sidecar counts by EXISTENCE, not size. The VFS creates both on every open
and removes neither on close, so an interrupted open can leave zero-byte sidecars that
pin a database to write-ahead just as firmly as full ones.

## Restoring a recovery backup

The recovery zip (`getRawSqliteDbBackup`, used when the database won't open) bundles the
sidecars, because the reset that follows deletes them. `importRawSqliteDb` therefore takes
the whole fileset, not one `.db`: the archive as downloaded, or the `.db` selected together
with the sidecars if the browser already expanded it (Safari does). The sidecars are
written first and the `.db` last, so an interrupted restore leaves no database rather than
one that opens, reports `integrity_check` ok, and is missing whatever the log held.

Restoring a lone `.db` extracted from such an archive still drops those frames, and nothing
can detect it — a bare `.db` is exactly what a checkpointed export produces. That is why
the archive is the thing to hand back.
