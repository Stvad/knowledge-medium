# Agent SQL execution budgets

> **Status:** investigation only; no runtime fix. Last verified against installed
> `@powersync/web` 2.5.0 and `@journeyapps/wa-sqlite` 2.0.7 on 2026-11-16.

An abandoned bridge command can continue occupying a SQLite connection after
its caller times out. This investigation addresses the cancellation mechanism,
not the SQL that caused the expensive read. The implementation issue remains
open: [#1734](https://github.com/Stvad/knowledge-medium/issues/1734).

## Decision

Stop before changing the runtime: PowerSync exposes no statement execution
budget or raw-connection initialization hook in this installed version.
A Promise timeout in the bridge would report failure while leaving SQLite busy.
Worker termination also fails to return the leased pool slot.

The smallest promising mechanism is a **worker-local deadline checked by
wa-sqlite's progress handler**. Integrating it needs a PowerSync change or a
maintained dependency patch. This is a proposed next step, not an implemented
or verified integration. No reads have gained a budget; writes are unchanged.

## Browser measurements

Measured in a visible Playwright Chromium 156 window with its own scratch
profile, against this branch's own `pnpm dev`. No signed-in account or live
client data was used. The raw wa-sqlite probe used `MemoryVFS`; the PowerSync
pool probe used a separate scratch `OPFSWriteAheadVFS` database and the stock
PowerSync worker behind the supported `worker` factory option.

The CPU-bound statement was:

```sql
WITH RECURSIVE count(x) AS (
  VALUES(1)
  UNION ALL
  SELECT x + 1 FROM count WHERE x < 1000000000
)
SELECT sum(x) FROM count;
```

| Probe | Observed result |
| --- | --- |
| Raw wa-sqlite progress callback every 10,000 VM operations, 100 ms deadline | `SQLITE_INTERRUPT` (code 9, `interrupted`) after 100.4 ms |
| Following raw query, counting to 10 on the same connection | Returned 55 in 0.2 ms |
| Warm raw query counting to 5,000,000, without handler / with non-expiring handler | 800.0 / 793.7 ms, 9,000 callbacks; one pair does not establish overhead |
| Interrupt message sent after worker announced query start, counting to 10,000,000 | Query completed normally after 1,631.8 ms; interrupt acknowledgement arrived 1,632.0 ms after sending |
| PowerSync `readLock(tx => tx.getAll(sql), {timeoutMs: 50})`, counting to 10,000,000 | Completed successfully after 2,645.1 ms, despite the 50 ms option |
| Terminate PowerSync's read-only worker during a billion-iteration read, while holding the writer lease | After another 251.2 ms, both the abandoned read and a following `SELECT 1` were still pending; worker count remained two |
| Release the held writer after terminating the reader | Following `SELECT 1` succeeded on the surviving writer; the abandoned query remained pending |

For the termination probe, the long read was submitted while the writer was
held, then the read-only worker was terminated after 100 ms. This establishes
pool behavior after termination; it does not independently prove exactly which
wasm instruction was executing at termination.

The deadline callback compared `performance.now()` with a deadline computed
inside the worker and returned 1 at expiry. The handler was removed before the
following query. The interrupt probe called the exported
`module._sqlite3_interrupt(db)` from the worker's message handler. Cross-context
latency used `performance.timeOrigin + performance.now()`, not unrelated local
clock origins. These are browser experiments, not committed regression tests.

## Installed-source findings

Paths below are relative to the named dependency's package root.

- PowerSync `src/db/adapters/options.ts` exposes a worker factory, but no
  execution-budget or raw SQLite initialization callback.
- `src/db/adapters/acquireFromPool.ts` applies `timeoutMs` to acquiring a
  connection. Once acquired, it awaits the callback; it does not stop execution.
- `src/db/adapters/wa-sqlite/DatabaseServer.ts` passes the acquisition timeout
  into `acquireConnection`, then executes SQL through a lease without a deadline.
- `src/db/adapters/wa-sqlite/RawSqliteConnection.ts` owns the private database
  pointer and calls `api.step(stmt)` without a progress handler.
- wa-sqlite `src/sqlite-api.js` exposes `progress_handler`; its synchronous wasm
  module exports `_sqlite3_interrupt` and `_sqlite3_stmt_readonly`. A progress
  callback can run during the synchronous step; an incoming worker message
  cannot preempt that step.
- PowerSync `src/db/adapters/AsyncWebAdapter.ts` allows reads on the writer as
  well as additional readers. A blanket busy-worker termination policy cannot
  assume that worker is read-only.
- `src/db/adapters/wa-sqlite/DatabaseClient.ts` awaits the worker RPC before
  returning its lease in `finally`. For these tab-owned workers,
  `remoteCanCloseUnexpectedly` is false. Termination does not reject outstanding
  RPCs or replace the connection. Reopening a separate worker alone would not
  repair the outstanding RPC or the occupied pool slot.

## Next implementation and verification boundary

Prefer a PowerSync execution-budget API over replacing its worker protocol or
pool. It must carry the deadline into the worker, scope the progress handler
to eligible read execution, remove it in `finally`, and preserve cleanup of an
interrupted prepared statement and connection lease. Reads dispatched to the
writer connection need protection too; normal write transactions must remain
outside the budget. An agent-only deadline also needs propagation through the
Repo queries used by structured commands, not only raw `sql`.

A dependency patch would carry changes across the configuration/RPC/raw
execution layers and their shipped JavaScript/types, and must be revalidated
when upgrading PowerSync. That maintenance cost is reasoned from the installed
source; no patch size or integration effort was measured.

Still unverified: deadline propagation through the bridge and Repo; a clear
budget error reaching the caller before its timeout; OPFS pool recovery after
a progress-handler interruption; statement-cache reuse after interruption;
write-transaction exclusion; other VFSes and browsers. No runtime guard was
added, so there is no guard to mutation-check. The raw browser probe proves the
SQLite primitive, not the requested bridge-level regression test.
