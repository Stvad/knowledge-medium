# Spike: can `PRAGMA optimize` replace the custom auto-ANALYZE machinery?

> **Status:** implemented — the recommendation below was carried out in the same
> PR. Measured 2026-07-30 against a live production client (347,350 blocks,
> wa-sqlite 3.53.0 / OPFS). Last verified against code: 2026-07-30.
>
> Two deviations from what §6 originally recommended, both deliberate; see
> [§10 What actually shipped](#10-what-actually-shipped) for the reasoning and
> for the post-implementation verification against the live client.

**Recommendation: REPLACE**, with three non-negotiable implementation details
(§6). `PRAGMA optimize` covers every case the current two-axis trigger covers,
plus one it explicitly gives up on, at roughly 1/1000th the steady-state cost.
It is not a drop-in — the half of its heuristic that handles stale stats only
fires for tables the *connection* has planned a query against, which has to be
arranged deliberately.

---

## 1. What was measured, and where

Two harnesses, because neither alone is sufficient:

**Offline fixture** (`node:sqlite` 3.53.3, local NVMe). The live client's exact
DDL, dumped from its `sqlite_master`, seeded to the live client's exact
cardinalities (read off its `sqlite_stat1` + `COUNT(DISTINCT …)`):

| table | rows | shape |
| --- | --- | --- |
| `blocks` | 347,350 | 325,848 active, 3 workspaces, parent fanout 4 |
| `block_references` | 225,600 | 3 workspaces, 33,140 aliases, 28,068 targets |
| `block_types` | 64,343 | 52 types, 55,128 typed blocks |
| `block_aliases` | 30,709 | |
| `row_events` | 444,222 | |
| `blocks_fts` | 318,606 | trigram |

This is where multi-state experiments live (fresh connections, damaged stats,
new indexes) — things that need opening and closing connections at will.

**Live production client** via the agent bridge (`--profile chrome-prod-stvad`),
347,350 blocks on wa-sqlite/OPFS. This is where the wa-sqlite-specific and
real-I/O answers live. **Every write-side measurement ran inside a
`db.writeTransaction` that was then rolled back**; `sqlite_stat1` was snapshotted
before and after each probe and confirmed byte-identical. The client's stats and
data were never modified.

The fixture reproduces the regression faithfully: the grouped-backlinks
type-candidates leg runs **1790ms with no stats and 0.1ms after ANALYZE**, with
the same plan inversion described in `clientSchema.ts` — the planner drives from
`SEARCH refs USING INDEX idx_block_references_ws_alias (workspace_id=?)` instead
of from the 4-row `json_each` context set.

---

## 2. The four questions

### Q1 — Does PowerSync accept these PRAGMAs, and does `PRAGMA optimize` write `sqlite_stat1` under wa-sqlite/OPFS?

**Yes to both, verified on the live client.**

- `PRAGMA analysis_limit=400` is accepted through `db.execute` and reads back as
  `400`. `PRAGMA optimize(…)` returns rows through both `db.execute`
  (`result.rows._array`) and `db.getAll`.
- The write half was confirmed by reproducing the actual production trigger
  inside a rolled-back transaction: create a real index on `block_references`,
  run `PRAGMA optimize`, observe the new `sqlite_stat1` row appear.

```
createIndexMs:         172
dryRun_defaultMask:    ["ANALYZE \"main\".\"block_references\""]
optimizeMs:            770
statForNewIndex:       [{ idx: "idx_spike_tmp", stat: "225605 4 4" }]
indexGoneAfterRollback: true      // and the live stats were untouched
```

No prior query was issued on that connection. `PRAGMA optimize` found the new
index on its own and analyzed the table.

> **Trap for the implementation:** a single `db.execute('PRAGMA analysis_limit=400;
> PRAGMA optimize;')` silently runs **only the first statement**. Verified on the
> live client — the call returned the `analysis_limit` row and no optimize row.
> They must be separate `execute` calls on the same connection.

### Q2 — Do `analysis_limit`-approximate stats actually fix the pathological plan?

**Yes.** The exact scenario — `idx_block_references_ws_alias` dropped and
recreated over an already-analyzed DB (which is literally what
`backfillBlockReferencesSourceFieldIfNeeded` does), then a fresh connection:

| state | plan drives from | query |
| --- | --- | --- |
| new index, unfixed | `idx_block_references_ws_alias (workspace_id=?)` | **895.6 ms** |
| `analysis_limit=400` + `PRAGMA optimize` | `json_each` → PK seek | **0.1 ms** |
| full `ANALYZE` (today's fix) | `json_each` → PK seek | **0.1 ms** |

`PRAGMA optimize` cost **14.9 ms** versus **271.3 ms** for the full ANALYZE — an
18x reduction, because it re-analyzes only `block_references` rather than every
table in the file.

The approximation is real but directionally sufficient. Full ANALYZE records
`225600 75200 5` for that index; `analysis_limit=400` records `225600 401 3`.
The recorded 401 is a ~187x *underestimate* of the true 75,200 — but it is still
40x above SQLite's no-stats default of ~10, and that is what flips the join
order.

To check the approximation isn't buying this one plan at another's expense, all
8 hot query shapes (subtree CTE, backlinks-by-target, alias enumeration, typed
blocks, children-by-parent, workspace scan, refs-of-source, grouped-backlinks
candidates) were planned under full stats and under `analysis_limit=400` stats:
**zero plan divergence**.

One reassuring detail: `analysis_limit` approximates only the per-column
distinct-value averages. **The leading row count stays exact** — `blocks` records
`325848` either way, `block_references` records `225600` either way. So anything
reading the recorded row estimate keeps working under a limit (this mattered for
the then-current `getBlocksStatEstimate`, since deleted).

### Q3 — Does the heuristic cover the legacy `"0 0"` state?

**Yes, but conditionally — and this is the one genuine gap.**

`PRAGMA optimize`'s stale-stats rule only considers tables **the connection has
planned a query against**. With `blocks` stats forced to `"0 0"`:

| what the connection did first | did `PRAGMA optimize` repair it? |
| --- | --- |
| nothing | **no** |
| `SELECT COUNT(*) FROM blocks` | **no** |
| `UPDATE` one row of `blocks` | **no** |
| queried a *different* table | **no** |
| `SELECT … WHERE workspace_id=? AND deleted=0` | yes |
| `EXPLAIN QUERY PLAN` of that query | yes |
| `prepare()` of that query, never stepped | yes |

The flag is set at **planning** time, not execution time. Preparing is enough;
executing is not required; an unconstrained `COUNT(*)` or a PK-targeted `UPDATE`
does not arm it.

This matters concretely: today's `runAnalyzeIfStale` opens with
`SELECT COUNT(*) FROM blocks`, which would **not** arm the table. The fix is
cheap and is folded into the recommendation (§6.1).

The new-index rule is *not* subject to this — it fired on a virgin connection
both offline (E2b) and on the live client (Q1 above). **The axis that caused the
6297ms regression is the axis that needs no arming.**

> **Methodology note.** An earlier live probe appeared to show `PRAGMA optimize`
> failing to repair anything on wa-sqlite. That result was an artifact: it
> damaged `sqlite_stat1` with a direct `UPDATE`, which does not invalidate
> SQLite's in-memory copy of the stats, so the heuristic never saw the damage.
> Reproduced offline (`samecon.mjs` T1/T2) to confirm the artifact rather than a
> wa-sqlite limitation; `ANALYZE sqlite_master` does not reload them either. Only
> a schema change (or a connection reopen) does. The Q1 probe above uses a real
> `CREATE INDEX` for exactly this reason.

### Q4 — How long does it take on a 347k client?

Live client, each run inside a rolled-back write transaction, alternating,
3 reps. The first two runs are cold-cache and app-contended; steady state is
what the last four show:

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| full `ANALYZE` | 3103 ms | 654 ms | 665 ms |
| `analysis_limit=400` `ANALYZE` | 3219 ms | 296 ms | 288 ms |

Pragma effectiveness was asserted from the stats each run produced
(`225605 75202 7` unbounded vs `225605 134 3` limited), not assumed.

Per-table, `analysis_limit=400`, warm: `block_references` **52 ms**, `blocks`
**62 ms**, `row_events` 43 ms, `ps_oplog` 65 ms, `block_types` 1 ms,
`block_aliases` 1 ms. Unbounded single-table: `block_references` 147 ms,
`blocks` 154 ms.

**On a settled client, the whole proposed sequence costs 2 ms of arming plus
0 ms of optimize, and writes nothing.** Measured live, end to end.

Two corrections to expectations worth recording:

1. **A first measurement showed 8770 ms / 7428 ms and suggested `analysis_limit`
   barely helped. That was cold-cache and contention, not signal.** Repeated
   alternating runs put the warm ratio at ~2.2x (654 → 296 ms).
2. **`analysis_limit` is not where the win comes from.** It roughly halves a
   whole-database ANALYZE. What actually removes the multi-second park is
   `PRAGMA optimize` analyzing *only the stale table* — 52 ms instead of 655 ms,
   and 0 ms when nothing is stale. The brief's framing ("`analysis_limit` bounds
   the scan, which addresses the multi-second-park half") credits the wrong
   mechanism; the conclusion still holds, for a better reason.

---

## 3. Coverage, case by case

Each row was run end-to-end against the fixture: build the state, close, reopen
(next boot), time the real query, run the proposed sequence, time it again.

| case | today | `PRAGMA optimize` | query before → after | cost |
| --- | --- | --- | --- | --- |
| new index over analyzed DB | ✅ fingerprint | ✅ | 719 → 0.1 ms | 14 ms |
| side table dropped + rebuilt | ✅ stat1-keys | ✅ | 733 → 0.1 ms | 14 ms |
| degenerate `"0 0"` stats | ✅ growth factor | ✅ *(needs arming)* | 835 → 0.2 ms | 33 ms |
| never analyzed (fresh device) | ✅ | ✅ | 734 → 0.1 ms | 52 ms |
| analyzed while tiny, then filled | ✅ 4x | ✅ >10x only | 0.1 → 0.1 ms | 18 ms |
| `block_types` empty at ANALYZE, then fills | ❌ **accepted gap** | ✅ | 0.1 → 0.1 ms | 2 ms |
| settled (control) | — | ✅ no-op | 0 → 0 ms | **0 ms** |

Two things stand out.

**It closes a gap the current design documents as accepted.** The
`SELECT_STAT1_KEYS_SQL` comment states that a table empty at ANALYZE time and
later filled is not detected, names `block_types` as sitting under that gap, and
accepts it on anti-correlation grounds. `PRAGMA optimize` detects and fixes it in
2 ms, because "index with no `sqlite_stat1` row" is precisely its trigger.

**The hysteresis band widens from 4x to 10x.** Today's `ANALYZE_GROWTH_FACTOR`
re-analyzes on 4x drift in either direction; SQLite's rule is ~10x. Measured
directly: 347k → 35k (10x) re-analyzes, 347k → 3.5k re-analyzes, no change does
not. A table analyzed at 30k and grown to 347k (11.6x) re-analyzes; analyzed at
100k and grown to 347k (3.5x) does not. The measured consequence of sitting in
that band is nil — the "analyzed while tiny, then filled" row above was already
0.1 ms *before* the fix, because proportionally-wrong stats still rank join
orders correctly. Order of magnitude is what the planner cares about, which is
the same argument the current 4x constant's own doc comment makes.

---

## 4. Steady-state cost, which is the real argument

| | today | proposed |
| --- | --- | --- |
| boot, nothing stale | `COUNT(*)` over 347k rows + 4 metadata queries | 2 ms arming + 0 ms optimize |
| boot, something stale | full ANALYZE: 655 ms warm, 3.1 s cold | one table: 14–52 ms |
| manual command | full ANALYZE | unchanged (kept as escape hatch) |

Today's design pays a full-table `COUNT(*)` on **every** idle check just to
decide whether to act, then re-analyzes **every table in the file** when it does.
`PRAGMA optimize` asks SQLite, which already knows, and acts only on what moved.

---

## 5. What can be deleted

All of this exists to answer "are the stats stale?", which SQLite answers itself:

- `ANALYZE_MIN_BLOCKS`, `ANALYZE_GROWTH_FACTOR`
- `SELECT_BLOCKS_STAT_ESTIMATE_SQL`, `SELECT_SQLITE_STAT1_EXISTS_SQL`,
  `getBlocksStatEstimate`, `analyzeIsWarranted` (but NOT `getBlocksCount` /
  `SELECT_BLOCKS_COUNT_SQL` — see §10)
- `SELECT_INDEX_SET_SQL`, `SELECT_STAT1_KEYS_SQL`, `analyzeFingerprint`,
  `readAnalyzeFingerprint`
- the entire marker family: `ANALYZE_INDEX_SET_MARKER_PREFIX`,
  `ANALYZE_MARKER_LIKE`, `SELECT_ANALYZE_INDEX_SET_MARKER_SQL`,
  `assertInlinableFingerprint`, `recordAnalyzeMarkerSql`,
  `clearOtherAnalyzeMarkersSql`, `analyzeMarkerMatches`, `recordAnalyzeMarker`,
  `analyzeAndRecord`
- the `previousEstimate` / drift fields of `AnalyzeResult`

Roughly 200 lines of source plus their tests. `fnv1a32Hex` stays —
`src/data/typeColors.ts` uses it independently.

Existing clients carry an orphaned `analyze_index_set:<hash>` row in
`client_schema_state`. One `DELETE … WHERE key LIKE 'analyze\_index\_set:%'
ESCAPE '\'` cleans it up; leaving it is harmless but untidy.

---

## 6. Implementation details that are load-bearing

### 6.1 Arming is required, and must be pinned by a test

```ts
await db.execute('PRAGMA analysis_limit=400')
for (const {sql, params} of ARM_PROBES) {
  await db.execute(`EXPLAIN QUERY PLAN ${sql}`, params)
}
await db.execute('PRAGMA optimize')
```

One `EXPLAIN QUERY PLAN` probe per hot table (`blocks`, `block_references`,
`block_types`, `block_aliases`), each shaped like the real workload — an indexed
lookup, not a `COUNT(*)`. `EXPLAIN QUERY PLAN` never touches a data page;
measured at **2 ms for all four on the live client**.

This is the single most fragile part of the change: an undocumented dependency
on when SQLite sets its internal "this table might benefit from stats" flag. It
must be pinned by a test that fails when the arming step is removed — otherwise
the stale-stats axis regresses silently and the suite stays green. Note that
such a test has to go through the *new-index-free* path (damaged stats + a
connection reopen), since the new-index path passes with or without arming.

### 6.2 `analysis_limit` must be set on the same connection, immediately before

It is a per-connection setting, it does not survive a connection being recycled,
and **without it `PRAGMA optimize` runs an unbounded ANALYZE** on whatever it
decides is stale. Both statements go through `db.execute`, which PowerSync routes
to its single write connection — but they must be separate calls (§Q1 trap).
Reset it to `0` afterwards so a later manual ANALYZE isn't silently limited.

### 6.3 Keep the manual full ANALYZE

`runAnalyzeNow` (the db-maintenance palette command) should stay an unbounded
full `ANALYZE` with `analysis_limit=0` — it is the escape hatch for exactly the
case where the heuristic was wrong, and it should not be limited. Because the
sample limit is a *connection* setting, the manual path has to clear it
explicitly, or it silently inherits whatever the automatic path last set.

*(This section originally also recommended keeping the materialization gate.
That was written against a tree that still had one. See §10.)*

---

## 7. Residual risks

1. **Arming is behavioural, not contractual.** If a future SQLite changes when
   the flag is set, the stale-stats axis stops working silently. Mitigated by:
   the axis that caused the actual regression (new index) does not depend on it,
   and the manual full-ANALYZE command remains.
2. **Stats become approximate.** Zero plan divergence across 8 hot queries, and
   row counts stay exact — but a future query whose cost estimate lands between
   401 and the true selectivity could plan differently than it does today. If
   that ever shows up, `analysis_limit=1000` or `0` are both available; the whole
   argument survives without `analysis_limit` at all, since the win is table
   selectivity, not scan bounding.
3. **4x → 10x hysteresis.** Measured harmless; recorded here so a future
   regression in that band is recognisable rather than mysterious.
4. **Not verified in production:** that PowerSync's write connection would be
   armed for the hot tables by ordinary app traffic. §6.1 makes this moot by
   arming explicitly rather than depending on it.

---

## 8. Suggested sequencing

One change, not a staged rollout — the coverage table has no regressions in it
and the escape hatch stays. But land it with the §6.1 revert-test written
*first*, and confirm on the live client afterwards that
`PRAGMA optimize(0x03)` (the faithful dry run of the default mask; `optimize(-1)`
over-reports because it also sets the "analyze all tables" bit) returns empty on
a settled DB and names the right table after a release that adds an index.

---

## 9. Reproducing

Everything above is re-runnable from this directory. No app checkout state is
needed beyond `node` — the fixture is built from `live-schema.json` (a plain
`sqlite_master` dump: DDL only, no rows, no ids).

```bash
node docs/pragma-optimize-spike/build.mjs          # ~12s, writes a 504MB fixture.db
node docs/pragma-optimize-spike/validate-design.mjs # §3 coverage table
```

| script | what it produces |
| --- | --- |
| `build.mjs` | the fixture, at the live client's cardinalities |
| `experiments.mjs` | §2 Q2 — the four stat states, plan + latency (E1/E2), `"0 0"` (E3), repeat-boot cost (E4) |
| `experiments2.mjs` | §2 Q3 arming table (A), plan divergence full vs limited (B), row-count drift (E) |
| `experiments3.mjs` | §3 growth cases (F), the `block_types` gap (G), steady-state cost (H) |
| `experiments4.mjs` | that `optimize(0x03)` is a faithful dry run of the default mask and `optimize(-1)` is not |
| `samecon.mjs` | why a direct `sqlite_stat1` edit is invisible to the heuristic (the Q3 methodology note) |
| `validate-design.mjs` | §3 — the proposed sequence against every case, end to end |

`live-probes/*.js` are run against a real client through the agent bridge; each
wraps its writes in a rolled-back transaction and asserts `sqlite_stat1` is
unchanged afterwards:

```bash
pnpm agent --profile <name> eval "$(cat docs/pragma-optimize-spike/live-probes/live-probe6.js)"
```

- `live-probe2.js` / `live-probe3.js` — §2 Q4 timings (3 is the trustworthy one:
  alternating runs, asserts the pragma took effect)
- `live-probe4.js` — the probe whose null result turned out to be an artifact
- `live-probe5.js` — §2 Q1, the definitive `PRAGMA optimize` write test
- `live-probe6.js` — §6 proposed sequence, end to end, on a settled client

---

## 10. What actually shipped

The recommendation was implemented in the same PR. Two deviations from §5/§6:

**The materialization gate was not kept.** §6.3 argued for keeping it. By the
time this landed, `3ac46485f` had already reverted it on stronger grounds than
"it's nearly free": the probe missed the *largest* materialization path
(`observer.materializeWorkspace` reads `blocks_synced` directly and never touches
the `blocks_synced_changes` queue the gate watched), and on exhaustion a session
could end up with no stats at all. A gate that misses the biggest instance of
what it guards while risking a strictly worse outcome is not worth its cost. The
reasoning is preserved at the declaration site in `clientSchema.ts` so it isn't
reinvented. `PRAGMA optimize` makes being wrong here cheaper anyway — a mid-drain
pass re-analyzes one table for tens of milliseconds.

**`getBlocksCount` was kept**, though §5 listed it for deletion. It has exactly
one caller left: the manual command's toast ("Query statistics rebuilt over N
blocks"). A `COUNT(*)` is fine on a user-initiated command; deleting it to hit a
bullet in this document would have cost a user-facing detail for nothing. The
automatic path no longer counts anything, which was the point.

### Verification

`pnpm run check`: 563 files, 6508 tests, passed.

Every guard clause was revert-tested individually — each one, removed on its own,
fails exactly one named test:

| clause removed | test that fails |
| --- | --- |
| the arming loop | `arming (stale-stats axis) > repairs degenerate "0 0" stats` |
| `PRAGMA analysis_limit=400` | `arming > samples rather than fully scanning` |
| the `finally` that restores the limit | `restores analysis_limit even when the optimize throws` |
| the limit reset in `runAnalyzeNow` | `runAnalyzeNow > is unbounded even after the automatic path ran` |
| the per-probe `try`/`catch` | `still analyzes when a table an arming probe names is absent` |
| a probe rewritten as a write | `ANALYZE_ARMING_PROBES > are reads, so the …guard passes them through` |
| `PRAGMA optimize` itself | 7 tests |

The `analysis_limit` clause needed a fixture built for it — at ordinary test
sizes the limit never binds, so it passed with the PRAGMA removed. The arming
fixture now puts 500 rows behind a single `workspace_id`, which makes the
sampling observable in the recorded stat (and incidentally pins the "row count
stays exact" property from §Q2).

### The shipped sequence, replayed against the live 347k client

Extracted from `clientSchema.ts` so there is no drift between what was tested and
what ships, and run inside a rolled-back transaction:

| | result |
| --- | --- |
| settled client | 4 ms arming, `proposed: []`, **0 ms** optimize, nothing written |
| brand-new index, no stat row | dry run names `block_references`, optimize repairs it in **858 ms**, stat row appears |
| after rollback | index gone, `analysis_limit` back to 0, live stats untouched |

The 858 ms is the one-table repair on OPFS with a just-built index — higher than
the 52 ms warm figure in §Q4 because the fresh index's pages are cold. It is paid
once, at deep idle, on the boot after a release that adds an index. The old path
paid a `COUNT(*)` over 347k rows on *every* boot to decide, then 655 ms–3.1 s for
the whole file when it acted.
