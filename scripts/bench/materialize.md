# Workspace materialization benchmarks

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm exec vite-node --config vitest.config.ts scripts/bench/bench-materialize.ts --records 3000 --reps 3
node scripts/bench/bench-materialize-browser.mjs 1000 3 tmp/materialize-webkit.json
node node_modules/vite-node/dist/cli.mjs --config vitest.config.ts scripts/bench/bench-materialize.ts --records 3000 --reps 3 --workflow
```

The browser runner requires Playwright WebKit (`pnpm exec playwright install webkit`).
It serves a separate localhost origin with no environment files, creates a disposable
persistent browser profile, and never connects to a sync server. Persistent mode is
necessary because WebKit's private browsing mode does not support the OPFS backend.
The profile is removed when the runner exits normally or reports an error.

Both runners use the same deterministic records, production materializer, and
1,000-record windows with the production default read chunk size. The fixture
includes ordinary text, page aliases, exact references, field forms, properties,
and references. The Node runner uses `createTestDb`; WebKit uses PowerSync's
SQLite worker with `OPFSCoopSyncVFS`, core production indexes/triggers, and static
plugin schema contributions. WebKit also uses the real IndexedDB key store and
production key resolver; Node uses an in-memory key. The materializability policy
is fixed to copy/decrypt, excluding workspace-entry policy checks.

Each case has one discarded warmup and the requested number of measured samples:

- `initial`: empty local `blocks`, with all incoming rows staged.
- `echo-repass`: local plaintext already matches staging; flag every staged row
  again before measuring a no-op materialization pass.
- Both cases run in plaintext and encrypted modes.

Encryption, fixture staging, reset, echo setup, and validation are outside the
measured region. Validation checks all plaintext cells and every derived target
and field bit, along with row counts, cleared staging flags, and zero uploads.
The initial phase includes reads, policy/gate decisions, key lookup, and decrypt;
it is not a pure crypto timer. Transaction time includes its SQLite worker calls;
do not add SQL durations to transaction time. Key time is a subset of phase one.

This isolates materialization from network download, React rendering, observer
invalidation, and deferred alias-repair work. Desktop WebKit measurements explain
the code's costs but do not predict a particular iPad's throughput. Run comparisons
sequentially on the same machine and summarize medians, retaining raw samples.

The optional Node-only `--workflow` case adds a separate Repo-level path using the
same synthetic fixture and test database: `drainSyncWorkspace` followed by the
scheduled one-time reconciliation rescan. It uses `createSyncResolver` with an
in-memory key store and a generated workspace key, measures both phases and their
SQL/key/derivation calls, and records Repo invalidation counters. The scheduled
phase is fenced on its reconciliation-marker read before `awaitReconcileRescans`
drains the fired job. It excludes app startup, React, device storage, and network
sync; no query handles are registered, so the invalidation counter is expected to
remain zero in this harness. WebKit remains focused on the lower-level materializer
path.

## Measured comparison

Measured 2026-10-21 on the same desktop, sequentially, with one warmup and
three measured repetitions per case. Before: `be54e8e7de4`; optimized:
PR #1380, including retryable key-store failure handling. Both versions ran
the same benchmark code and validation.
WebKit reported Safari 26.4. These are local test-database results.

| Runtime / case | Records | Before median | After median | Speedup |
| --- | ---: | ---: | ---: | ---: |
| WebKit, encrypted initial | 1,000 | 4,128 ms | 216 ms | 19.1x |
| WebKit, plaintext initial | 1,000 | 694 ms | 189 ms | 3.7x |
| WebKit, encrypted echo/repass | 1,000 | 4,496 ms | 71 ms | 63.3x |
| WebKit, plaintext echo/repass | 1,000 | 31 ms | 31 ms | unchanged |
| Node, encrypted initial | 3,000 | 1,592 ms | 455 ms | 3.5x |
| Node, plaintext initial | 3,000 | 1,359 ms | 326 ms | 4.2x |
| Node, encrypted echo/repass | 3,000 | 244 ms | 156 ms | 1.6x |
| Node, plaintext echo/repass | 3,000 | 42 ms | 40 ms | similar |

WebKit encrypted-initial samples were 4,128 / 3,529 / 4,892 ms before and
216 / 216 / 243 ms after. Median key lookup time fell from 3,025 ms for
1,000 reads to 3 ms for one read. Median phase one fell from 3,225 to 47 ms.
Total SQLite calls fell from 1,398 to 425: inserts dropped from 1,000 to 27;
per-row derived-column writes and alias lookups still run. The write transaction
median fell from 678 to 171 ms.

Node isolates the database improvement because its key is already in memory.
Its 3,000-row workload reduced insert calls from 3,000 to 81 and total SQL calls
from 4,194 to 1,275. The encrypted write transaction median fell from 1,373 to
317 ms; phase one fell from 219 to 139 ms.

The WebKit echo baseline varied from 2,865 to 4,520 ms. Two samples included an
approximately one-second transaction wait outside individual SQL timings;
its cause is not established. Treat that case's ratio as noisy. The initial
materialization improvement also appears in every sample and in the Node run.
All samples validated the original values, derived targets/field bits, zero
remaining staging flags, and zero uploads.

Key lookup failures abort the materialization window before its write transaction,
leaving the delivery queued for retry. Per-row quarantine is reserved for ciphertext
decode failures. A regression test fails the first key read, verifies that the queue
and local table are untouched, then retries the same delivery successfully.

## Follow-up: batch arrival derivation and reuse a completed scan

Measured 2026-10-21 with the same machine, fixture, and three measured samples
per case. Baseline production source is `origin/master` `772111c`; optimized
source is `0acb0c4` plus the joined stamp update (`UPDATE … FROM stamps`) that
passed the final targeted plan test. Before and after captures ran sequentially
in adjacent pairs. Each table cell gives median wall time and the full sample
range. SQL counts are exact; wall time includes the local SQLite worker and is
specific to this synthetic fixture.

| Runtime / case | Records | Before ms (range) | After ms (range) | SQL calls before → after |
| --- | ---: | ---: | ---: | ---: |
| Node, plaintext initial | 3,000 | 356.44 (356.36–357.81) | 222.14 (214.66–227.51) | 1,275 → 141 |
| Node, encrypted initial | 3,000 | 492.59 (491.81–503.79) | 360.89 (358.77–361.03) | 1,275 → 141 |
| Node, plaintext echo/repass | 3,000 | 45.58 (41.39–45.73) | 47.52 (44.22–49.92) | 33 → 33 |
| Node, encrypted echo/repass | 3,000 | 177.68 (175.30–185.66) | 184.75 (177.40–203.35) | 33 → 33 |
| WebKit, plaintext initial | 1,000 | 238 (223–260) | 122 (112–124) | 425 → 47 |
| WebKit, encrypted initial | 1,000 | 266 (259–267) | 150 (142–167) | 425 → 47 |
| WebKit, plaintext echo/repass | 1,000 | 42 (39–46) | 37 (37–38) | 11 → 11 |
| WebKit, encrypted echo/repass | 1,000 | 82 (81–83) | 80 (77–81) | 11 → 11 |

The initial materialization batches now resolve alias references in one CTE
query per window and stamp derived columns in joined batches. At 3,000 Node rows,
alias lookups fell from 231 individual queries to 3 batched queries, and stamp
writes fell from 924 row updates to 6 batched statements. WebKit's 1,000-row
case fell from 77 alias queries and 308 row updates to 1 alias query and 2
batched stamp statements. The no-op echo case kept the same total SQL count.

The Repo workflow case measures the first complete `drainSyncWorkspace` and the
scheduled reconciliation job that follows it:

| Workflow phase | Before ms (range) | After ms (range) | Full scans | SQL calls | Key reads | Derivation SQL calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial drain | 624.46 (612.26–664.61) | 349.95 (347.47–353.26) | 1 → 1 | 1,277 → 144 | 6 → 6 | 1,155 → 9 |
| Scheduled rescan | 170.85 (170.72–172.54) | 1.60 (1.51–1.65) | 1 → 0 | 30 → 1 | 6 → 0 | 0 → 0 |

The clean initial drain now records the completion marker. The scheduled job
reads that marker and skips the repeated workspace scan. Both workflow versions
validated 3,000 materialized rows, zero unapplied staging rows, zero uploads,
924 derived reference targets, and 231 field forms. Invalidation counters were
zero because this benchmark registers no query handles; the Repo observer and
its invalidation path ran, but the fixture had no subscribers to notify.

One after-only 100,000-row encrypted initial sample completed in 13,023.71 ms
(7,678 rows/s), with 4,700 SQL calls and 100 key reads. Validation passed for all
100,000 rows, with zero backlog or uploads, 30,771 reference targets, and 7,692
field forms. A previous 15.85-second scale sample exists, but it was not captured
as a paired before/after run, so treat this as scale context only.

Raw paired reports are `tmp/followup-native-before-adjacent.json`,
`tmp/followup-native-after-final.json`, `tmp/followup-webkit-before-adjacent.json`,
`tmp/followup-webkit-after-final.json`, `tmp/followup-workflow-before-adjacent.json`,
and `tmp/followup-workflow-after-final.json`. The 100k report is
`tmp/followup-native-100k-after-final.json`.

The clean baseline snapshot is `tmp/followup-baseline-final`, extracted from
`772111c`; its production source files are unchanged. The baseline benchmark core
keeps that revision's original single-alias SQL and `getOptional` lookup. The
archive-only compatibility diff is retained at `tmp/followup-baseline-shim.diff`:
it exports the existing SQL instrumentation wrapper and copies `onChange` across
its wrapper so the Repo workflow can start, and allows the archive's symlinked
shared `node_modules` directory through Vite's file server. The optimized runs
use the shared production lookup factory and joined stamp SQL.

An earlier paired capture overlapped an independent full Vitest run and showed
inflated native times; those raw reports remain in `tmp/followup-*-quiet.json`
and the earlier `tmp/followup-*-before.json` files, but are not used above. The
benchmark runner could not inspect other processes, so unrelated load cannot be ruled
out for the adjacent captures either. The tight sample ranges and exact SQL
counts support the work reduction; use timings as local comparisons, not device
throughput predictions.

## Variant matrix: where the initial write transaction goes

`bench-materialize.ts` takes variant flags; with none of them its output is
unchanged.

- `--modes none,e2ee`, `--scenarios initial,echo-repass`: run a subset.
- `--window N`: drain window size (production: 1,000).
- `--random-ids`: scatter the fixture's ids across the key space, as real
  UUIDs are. The default fixture's ids are sequential, so every index insert
  appends; that is the best case and not what a device sees.
- `--drop-triggers a,b`: drop the named triggers before the run.
- `--rebuild-derived`: after the pass, time one set-based rebuild of each
  derived table (for use with the insert triggers dropped).

Measured 2026-11-19, Node test DB, 100,000 encrypted rows, `initial` scenario,
two samples each after one warmup, run sequentially. The machine was under
heavy unrelated load throughout (load average 6–10 on 12 cores), so absolute
times are inflated and two samples of one variant differ by up to 6 s. Read
the large differences; the ones of a few seconds are not resolved.

| Variant | Wall ms (two samples) | Write tx ms | Rows/s |
| --- | ---: | ---: | ---: |
| A: sequential ids (the earlier baseline) | 13,057 / 14,242 | 8,671 / 9,686 | 7,659 / 7,022 |
| B: `--random-ids` | 25,763 / 32,507 | 21,644 / 26,770 | 3,882 / 3,076 |
| C: B + drop `blocks_row_event_insert` | 26,238 / 24,360 | 20,507 / 19,570 | 3,811 / 4,105 |
| D: B + drop `blocks_fts_insert` | 23,064 / 24,390 | 18,257 / 19,563 | 4,336 / 4,100 |
| E: B + drop `blocks_alias_insert`, `blocks_type_insert` | 26,395 / 27,363 | 21,677 / 22,530 | 3,789 / 3,655 |
| F: B + drop all four, then rebuild | 16,469 / 18,248 | 11,678 / 13,203 | 6,072 / 5,480 |
| G: B + `--window 5000` | 20,343 / 20,133 | 15,854 / 15,418 | 4,916 / 4,967 |
| H: B + `--window 20000` | 18,131 / 18,243 | 13,531 / 13,388 | 5,515 / 5,482 |

Phase one (reads, gates, decrypt) stayed at 4.1–5.7 s in every variant.

F's set-based rebuild took 1.2–1.4 s in total: `blocks_fts` 955 / 1,180 ms,
`blocks_fts_rowids` 153 / 132 ms, `block_aliases` 52 / 50 ms, `block_types`
31 / 33 ms. Rebuilt row counts matched a triggers-on run. The fixture has no
`$.types`, so the `block_types` rebuild ran over nothing.

What the matrix shows:

- Scattered ids roughly double the wall time and nearly triple the write
  transaction. Every earlier figure in this file used sequential ids and
  understates a real device by about that much.
- A larger window helps without touching the upsert: the multi-row upsert's
  summed time was the same in B, G and H (8.2–9.9 s), while the write
  transaction fell from 21.6–26.8 s to 13.4 s at 20,000. The difference is
  outside the timed statements. Per-transaction cost (commit) is the likely
  place; that was not broken down.
- No single trigger is the cost. Dropping the row-event trigger or the alias
  and type triggers is within noise; dropping the FTS trigger took the upsert
  from 8.2–9.9 s to 5.7–6.0 s.
- Dropping all four and rebuilding (F) is about a third faster than B, but it
  is not a like-for-like pass: reference derivation resolves through
  `block_aliases`, so with `blocks_alias_insert` gone it resolved 693 of 924
  targets in a 3,000-row check, and the rebuild does not repair them. E and F
  run with that validation skipped (`skippedDerivedReferenceValidation` in
  the output) and did less lookup work than a real pass would.

Not measured here: the WebKit/OPFS runner with these flags, windows and
dropped triggers combined, and any device.
