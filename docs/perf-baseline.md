# Data-layer perf baseline (post-migration)

Captured at the close of the data-layer redesign: kernel mutators +
HandleStore + sync `Block` facade + `repo.query` dispatcher (Phase 4)
+ `cycleDetected` via row\_events tail (Phase 5) all merged on master.
Branch: `master` at `98c938f`.
Hardware: M-series mac, Node 24.15, `@powersync/node` worker-thread DB.

This supersedes the earlier post-Phase-2 baseline. All callsites in the
bench suites now go through the typed `repo.query.X({...})` dispatcher;
the legacy `repo.findX` / `repo.subtree(id)` / `repo.children(id)`
factories were deleted in Phase 4 chunk C-2.

The bench harness lives in [scripts/bench/](../scripts/bench). Re-run
with `yarn bench [suite...]` (suites: `writes`, `reads`, `handles`,
`search`, `tail`, `scale`). Raw JSON results are in
[tmp/bench-results/](../tmp/bench-results/).

Each table reports mean / p50 / p95 / p99 in ms, plus per-op SQL
roundtrip counts where applicable (the data-layer-spec §2 goal #7
proxy: "tree walks push to SQL" — we count to verify nothing leaked
back to JS-side iteration).

---

## What changed since the last baseline

In priority order of impact:

1. **Alias index landed** (recommendation #2 from the previous
   baseline). A trigger-maintained `block_aliases(workspace_id, alias,
   alias_lower, block_id)` side-index replaced the json\_each scans.
   Result, single-key:
   - `aliasLookup`: **1.15 ms → 0.095 ms** (12× faster)
   - `aliasMatches` (autocomplete prefix): **1.20 ms → 0.49 ms**
     (2.4× faster)
   - `aliasesInWorkspace`: **1.85 ms → 1.28 ms** (1.4× faster)

2. **Tail × handle invalidate fan-out: 65.8 ms → 14.0 ms** for the
   "100-row sync burst with 10k registered handles, 1k matching"
   scenario (-79%). Two Phase 4 review fixes are responsible: `f4e4fd5`
   ("stop double-loading on matching invalidates") and `a7871a9`
   ("queue mid-load changes for re-check against post-load deps").
   This was the most-likely-to-bite UI scenario; it's now fast enough
   to be a non-issue at this scale.

3. **Multi-mutator tx batching: 8.20 ms → 6.03 ms** for the
   single-tx-of-50-creates path (-26%). The "single tx vs 50 separate
   txs" advantage widened from 9× to 8.2× — slightly less spread but
   absolute single-tx improved.

4. **`repo.query` dispatcher cost is negligible.** Warm dispatcher hit
   for `repo.query.children({id})` is 0.001 ms — same as the previous
   baseline's `repo.children(id)` factory. Args validation +
   canonical-key build + handle-store lookup all amortise to ~1 µs at
   this hardware. The dispatcher is not a perf concern.

What did **not** change since the previous baseline:

- The HandleStore inverted dep-index (recommendation #1) is **still
  not implemented** — `invalidate()` still walks all registered
  handles linearly. The bystander-handle write regression at 10k
  handles persists (1.7×–2.2× over the no-bystander baseline).
- Backlinks at 10k workspace × 50 refs/block improved 564 ms → 416 ms
  (-26%, mostly from incidental SQL-plan changes), but it's still the
  slowest read path and will still feel sluggish in a backlinks panel.
- Cache memory growth (recommendation #3) — no eviction policy
  landed.

---

## Headline findings (current state)

1. **§2 goal #7 still verified.** `repo.query.subtree({id})` for a
   tree of 1365 blocks at depth 5 costs **exactly 1 SQL query**.
   Recursive CTE doing its job; cycle-detection in the path-INSTR
   guard adds no measurable overhead.

2. **Cold-start "journal page" = 5 SQL roundtrips** for a 51-node page
   (1 load + 4 neighborhood/handle loads). Dispatcher-routing through
   `repo.query.X` did not change this count.

3. **Single keystroke (`mutate.setContent`)** on a warm leaf takes
   ~0.43 ms median and 5 SQL roundtrips. At 50k-block DB it's still
   ~0.4 ms — **no scale degradation**.

4. **Multi-mutator tx batching is ~8.2× faster** than separate
   `repo.mutate.X` calls (50-node tree: 6.03 ms in one tx vs 49.5 ms
   in 50 separate txs). Per-row overhead in separate-tx mode is
   dominated by `tx_context` set/clear, `command_events` row, and
   writeTransaction open/close.

5. **Tree CTEs flat across depth.** `ANCESTORS_SQL` at depth 10 vs
   5000 takes 0.16 ms vs 1.02 ms — the path-INSTR visited-id check is
   not a bottleneck.

6. **`handleStore.invalidate` is still linear in registered handles**
   (the open recommendation #1). p50 / mean:

   | registered N | p50 invalidate | mean |
   | --- | ---: | ---: |
   | 1 | 1 µs | 2 µs |
   | 100 | 7 µs | 9 µs |
   | 1 000 | 36 µs | 34 µs |
   | 10 000 | 258 µs | 330 µs |

   Real-end-to-end impact: a `setContent` write **with 10 000
   bystander handles registered** takes 1.17 ms vs 0.54 ms baseline —
   a **2.15× write-latency degradation**. (Previous baseline reported
   1.7×; the run-to-run variance moves the multiplier between roughly
   1.7× and 3.5×, but the trend is consistent: it gets monotonically
   worse with more handles.) Worth optimising before we expect users
   to mount thousands of `useHandle(...)` consumers on one page.

7. **`repo.query.backlinks` is still the slowest read path.** At 10k
   workspace with 50 refs/block, **mean is 416 ms**, p95 448 ms.
   Improved from 564 ms but still walks every row's references array
   via JSON1 EXISTS. The same trick that worked for aliases (a
   trigger-maintained inverted-edge table) should be applied here.

8. **Cache memory growth is still unbounded** (no eviction policy).
   The bench's per-block delta is GC-noisy, but the underlying issue
   (no LRU, every loaded block held forever) is unchanged. A long
   session that visits many pages will accumulate.

9. **Sync-burst tail throughput**: ~7 500 rows/sec consumed by the
   `row_events` tail (1340 ms for 10 000 sync rows + handle
   invalidations). For a typical sync arrival of 100 rows: ~13 ms
   total or ~1 ms isolated flush. **With 10 000 registered handles
   and 1k matching the burst, 100-row flush is now 14 ms** (was 66
   ms — see "What changed" §2). Tail itself is no longer a bottleneck
   even with thousands of consumers.

10. **`repo.query` dispatcher is free.** Warm hit ~1 µs (Map.get +
    schema.parse + handleStore.getOrCreate). Same identity-stability
    guarantees as the legacy factories; no perf cost from the typed
    dispatch boundary.

---

## Suite results

Numbers below come from the unified all-suite run in
[`tmp/bench-results/all.json`](../tmp/bench-results/all.json),
captured in one continuous 64-second sequence.

### Writes

| operation | mean (ms) | p95 | p99 | sql/op | Δ vs prev |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mutate.setContent` (warm leaf) | 0.49 | 0.71 | 2.07 | 5.0 | -4% |
| `mutate.createChild` (parent w/ 0 sibs, append) | 0.76 | 1.04 | 2.40 | 6.2 | -14% |
| `mutate.createChild` (parent w/ 100 sibs) | 0.99 | 1.27 | 3.05 | 6.2 | -5% |
| `mutate.createChild` (parent w/ 1000 sibs) | 2.90 | 3.63 | 5.21 | 6.2 | -8% |
| `mutate.createChild` (1000 sibs, position=first) | 2.99 | 3.73 | 5.06 | 6.2 | -12% |
| `mutate.insertChildren` (n=50 into 100-wide) | 8.93 | 9.27 | — | 66 | +3% |
| `mutate.insertChildren` (n=500 into 100-wide) | 75.4 | 81.9 | — | 606 | -1% |
| `mutate.indent` (mid sibling, 100-wide) | 1.01 | 1.41 | 3.05 | 9.9 | -13% |
| `mutate.move` (subtree → depth-100, cycle-check) | 1.02 | 1.43 | 2.33 | 8.3 | -5% |
| `mutate.delete` (subtree of 50) | 10.6 | 11.6 | — | 19.2 | +1% |
| `repo.tx { 50× tx.create }` (single tx) | **6.03** | 7.71 | — | 64.8 | **-26%** |
| 50× `mutate.createChild` (50 separate txs) | **49.5** | 63.9 | — | 360 | **-37%** |
| 10× `setContent` parallel (`Promise.all`) | 4.44 | 6.33 | 6.81 | 52 | -14% |

Writes are uniformly slightly faster or unchanged. Multi-mutator tx
got measurably better.

### Reads

| operation | mean (ms) | p95 | sql/op | Δ vs prev |
| --- | ---: | ---: | ---: | ---: |
| `repo.load(id)` cold | 0.057 | 0.083 | 1 | +16% |
| `repo.load(id, {children})` 10 ch | 0.20 | 0.53 | 2.4 | +25% |
| `repo.load(id, {children})` 100 ch | 0.45 | 0.64 | 2.4 | +5% |
| `repo.load(id, {children})` 1 000 ch | 2.96 | 3.18 | 2.4 | +5% |
| `repo.load(id, {children})` 10 000 ch | 32.1 | 40.8 | 2.4 | -7% |
| `repo.load(id, {ancestors})` depth 10 | 0.24 | 0.53 | 2.4 | -17% |
| `repo.load(id, {ancestors})` depth 100 | 1.23 | 1.86 | 2.4 | -22% |
| `repo.load(id, {ancestors})` depth 1000 | 1.28 | 1.65 | 2.4 | +9% |
| `repo.load(id, {descendants})` n=1111 | 5.51 | 6.18 | 2.4 | -14% |
| `SUBTREE_SQL` raw n=156 | 0.73 | 0.87 | — | 0% |
| `SUBTREE_SQL` raw n=1111 | 4.65 | 5.15 | — | +5% |
| `SUBTREE_SQL` raw n=11111 | 57.3 | 62.2 | — | -4% |
| `ANCESTORS_SQL` raw depth 10 | 0.16 | 0.28 | — | +14% |
| `ANCESTORS_SQL` raw depth 100 | 0.94 | 1.15 | — | -12% |
| `ANCESTORS_SQL` raw depth 1000 | 0.96 | 1.21 | — | -19% |
| `ANCESTORS_SQL` raw depth 5000 | 1.02 | 1.30 | — | 0% |
| `IS_DESCENDANT_OF_SQL` yes (depth 500) | 0.55 | 0.64 | — | 0% |
| `IS_DESCENDANT_OF_SQL` no (depth 500) | 0.075 | 0.109 | — | 0% |
| `CHILDREN_SQL` raw 10 ch | 0.10 | 0.16 | — | +11% |
| `CHILDREN_SQL` raw 1000 ch | 2.16 | 2.65 | — | -18% |
| `CHILDREN_SQL` raw 10000 ch | 21.0 | 29.3 | — | -15% |
| `repo.query.subtree({id})` cold load (n=341) | 2.23 | 2.46 | 1.2 | +5% |
| `repo.query.subtree({id}).peek()` warm | <0.001 | <0.001 | 0 | ~ |
| **§2 goal #7** subtree(n=1365, depth=5) | — | — | **1** | ✓ unchanged |
| **cold-start** open page (load+subtree+ancestors) | 3.07 | — | 5 | +13% |

Read paths roughly hold their numbers. CTE plans are stable; the
slight ±15% scatter on individual cells is run-to-run variance, not
a real regression.

### Handles

| operation | mean (ms) | p50 | Δ vs prev |
| --- | ---: | ---: | ---: |
| `repo.query.children({id})` identity hit | 0.001 | 0.001 | ~ |
| `handleStore.invalidate` (N=1, 1 match) | 0.002 | 0.001 | +100% (still <2 µs) |
| `handleStore.invalidate` (N=100, 1 match) | 0.009 | 0.007 | -80% |
| `handleStore.invalidate` (N=1000, 1 match) | 0.034 | 0.036 | -65% |
| `handleStore.invalidate` (N=10000, 1 match) | **0.330** | 0.258 | +22% |
| `handleStore.invalidate` (N=1000, all match → re-resolve) | 0.420 | 0.344 | +4% |
| LoaderHandle cycle (setContent on child → listener) | 0.731 | 0.717 | -11% |
| `BlockCache.setSnapshot` notify (1 sub) | 0.002 | 0.002 | ~ |
| `BlockCache.setSnapshot` notify (100 subs) | 0.003 | 0.002 | ~ |
| `BlockCache.setSnapshot` notify (1000 subs) | 0.008 | 0.008 | ~ |
| `BlockCache.setSnapshot` dedup (fingerprint match) | 0.001 | 0.001 | ~ |
| `mutate.setContent` w/ 0 bystander handles | 0.541 | 0.492 | -18% |
| `mutate.setContent` w/ 100 bystanders | 0.562 | 0.534 | -18% |
| `mutate.setContent` w/ 1000 bystanders | 1.749 | 0.792 | +152% (high variance) |
| `mutate.setContent` w/ **10 000 bystanders** | **1.165** | 1.097 | +5% |
| `setContent` leaf, depth=1 chain | 0.794 | 0.785 | +12% |
| `setContent` leaf, depth=5 chain | 0.805 | 0.826 | +10% |
| `setContent` leaf, depth=25 chain | 0.743 | 0.732 | -1% |
| `setContent` leaf, depth=100 chain | 1.172 | 1.006 | -33% |

Reading the bystander row: at p50 the slope is clean — 0.49 / 0.53 /
0.79 / 1.10 ms across 0 / 100 / 1k / 10k registered handles. That's
a **2.2× regression at 10k** vs no-bystander baseline, on the same
order as before. The mean column has GC-driven outliers; trust p50
for this row.

### Search

| operation | mean (ms) | p95 | Δ vs prev |
| --- | ---: | ---: | ---: |
| `repo.query.backlinks` (ws=1 000, refs=5) | 6.57 | 7.27 | +5% |
| `repo.query.backlinks` (ws=1 000, refs=50) | 28.1 | 30.3 | +8% |
| `repo.query.backlinks` (ws=10 000, refs=5) | 73.3 | 80.1 | -4% |
| `repo.query.backlinks` (ws=10 000, refs=50) | **416** | **448** | **-26%** |
| `repo.query.searchByContent` (ws=1 000) | 0.48 | 0.71 | +14% |
| `repo.query.searchByContent` (ws=10 000) | 2.18 | 2.93 | +1% |
| `repo.query.byType` (ws=10k, 1k tagged) | 2.17 | 2.71 | +2% |
| `repo.query.aliasLookup` | **0.095** | 0.148 | **-92%** ⚡ |
| `repo.query.aliasMatches` | **0.49** | 0.64 | **-60%** ⚡ |
| `repo.query.aliasesInWorkspace` (1k distinct) | **1.28** | 1.45 | **-31%** |
| `repo.query.firstChildByContent` (1000 sibs) | 0.117 | 0.172 | +11% |
| `repo.query.children({id})` dispatcher hit (warm) | 0.001 | 0.001 | (new) |

The alias index payoff is the biggest single perf win since the
last baseline. Backlinks improved organically but the worst-case
(10k × 50) is still a panel-killer.

### Tail (sync-applied invalidation path)

| operation | mean (ms) | flush ms | rows/s consumed | Δ vs prev |
| --- | ---: | ---: | ---: | ---: |
| `row_events` tail flush, burst N=10 | 1.64 | 0.6 | ~6 100 | -9% |
| `row_events` tail flush, burst N=100 | 12.5 | 1.1 | ~8 000 | +2% |
| `row_events` tail flush, burst N=1 000 | 136 | 4.2 | ~7 350 | +4% |
| `row_events` tail flush, burst N=10 000 | 1340 | 40.4 | ~7 460 | -14% |
| Tail flush burst N=100 + 10 000 handles, 1k match | **14.0** | — | — | **-79%** ⚡ |

The "mean ms" column above includes both the synthetic INSERT phase
(simulating the sync apply) AND the tail flush itself. The "flush ms"
isolates just the tail's drain pass — that's what runs on the live UI
thread. Phase 4 review fixes (stop double-loading; queue mid-load
changes) collapsed the 10k-handle tail-flush case from 65.8 ms to
14 ms.

### Scale

| operation | mean (ms) | meta | Δ vs prev |
| --- | ---: | --- | ---: |
| `populateFlat` (n=10 000) | 1277 | 7 830 rows/s | -8% |
| `mutate.setContent` (DB size 10 000) | 0.43 | sql=5.3 | -22% |
| `repo.load(id)` cold (DB size 10 000) | 0.070 | sql=1.0 | -19% |
| `populateFlat` (n=50 000) | 6757 | 7 400 rows/s | +7% |
| `mutate.setContent` (DB size 50 000) | 0.41 | **unchanged** with size | +18% |
| `repo.load(id)` cold (DB size 50 000) | 0.077 | **unchanged** with size | +17% |
| `populateLinearChain` (depth 1000) | 121 | 8 246 rows/s | +12% |
| `ANCESTORS_SQL` leaf depth 1000 | 1.19 | | +5% |
| `IS_DESCENDANT_OF_SQL` leaf-of-root depth 1000 | 0.63 | | +14% |
| `SUBTREE_SQL` root depth 1000 chain | 1.09 | | -4% |
| `populateLinearChain` (depth 5000) | 641 | | 0% |
| `ANCESTORS_SQL` leaf depth 5000 | 1.36 | | +11% |
| `IS_DESCENDANT_OF_SQL` leaf-of-root depth 5000 | 0.60 | | +3% |
| `SUBTREE_SQL` root depth 5000 chain | 1.15 | | +4% |
| `populateFanOut` (width=10 000) | 1292 | | +3% |
| `mutate.insertChildren` (n=10 at front, 10k sibs) | 23.5 | sql=18 wtx=6 | -2% |
| `tx.childrenOf` (parent has 10k sibs) | 21.7 | row serialization | -1% |
| Cache memory growth (N=10 000 / 50 000 loaded) | — | GC-noisy in this run | (n/a) |

Memory delta numbers came back GC-driven negative this run (the
populate dominated heap; after loading + GC, observed heap shrank).
The underlying point — no eviction, ~3 KB JS-heap per loaded block —
hasn't changed; we just need a steadier measurement harness to track
it (call out in follow-ups below).

---

## What's NOT covered yet

### Browser-side perf — still out of scope for the node bench

These need Playwright + React profiler:

- React render counts per keystroke (with the cache notify counts
  measured here as the data-layer ceiling, not React's actual render
  cost).
- `useEffect` retrigger rate on the journal page.
- Time-to-interactive on a real daily-note open.
- Long-page scroll perf (5k-block outline).

### Sync upload throughput — still out of scope

PowerSync's `powersync_crud` drain. We measure the local invalidation
path, not the upload one.

### Soak / long-session

A multi-hour run watching for handle leaks, undo-stack growth, and
cache RSS drift. Especially relevant given the still-unbounded cache;
worth scheduling once the eviction policy lands.

### Memory measurement reliability

The `process.memoryUsage()` deltas on `populateFlat → load all`
fluctuate wildly between runs because vite-node doesn't expose
`global.gc` and the populate phase dominates heap allocation. A
deterministic memory bench needs a `--expose-gc` flag and a forced
GC sweep before/after. Tracked as follow-up #6 below.

---

## Recommended follow-ups, in priority order

The first three carry over from the previous baseline; the rationale
is unchanged but the cost numbers are refreshed.

1. **(Highest, still open) Inverted index in `HandleStore.invalidate`.**
   Linear walk: O(handles) per commit. At 10 000 handles a
   `setContent` loses ~0.6 ms to the walk on top of 0.54 ms baseline
   — that's a **2.2× write regression** in scenarios where many
   subtree/children handles are mounted (think: a long outline page,
   a multi-pane workspace, or a backlinks-heavy daily note).

   Concrete shape: alongside `Map<key, RegisteredHandle>`, maintain
   `Map<dep-shape, Set<RegisteredHandle>>` keyed by row-id /
   parent-id / workspace-id / table. `register()` and `dispose()`
   maintain both indices; `invalidate(change)` unions only the
   bucketed handles for the change's keys, then runs `matches()` on
   each (the precise per-dep filter still needs to run because deps
   accumulate at row+parent+workspace granularity).

   Spec §9.2 leaves the data structure open. The class header
   already advertises "the store walks an inverted index" (line 11
   of `handleStore.ts`), but the implementation is still the linear
   walk. Closing that gap is the cleanest cost/value win on the
   table.

   Bench-side validation: the existing `bench-handles.ts`
   "handleStore.invalidate (N=… registered, 1 match)" rows give us
   the headline number to drive to constant time, plus the
   "mutate.setContent with N bystanders" rows to confirm end-to-end
   write latency loses its slope.

2. **(High, still open) Per-target backlinks index — apply the
   alias-index template.** `repo.query.backlinks` at 10k workspace ×
   50 refs/block is still 416 ms (down from 564 ms but unchanged in
   shape — JSON1 EXISTS scans every row's references array). The
   alias index proved the pattern works:

   - dedicated table `block_backrefs(target_id, source_id,
     workspace_id)` (or just `block_backrefs(target_id, source_id)`
     if we always join through `blocks.workspace_id`),
   - three triggers on `blocks` (insert / update OF references_json /
     soft-delete) that maintain it via `INSERT OR IGNORE` + `DELETE
     WHERE source_id = ?`,
   - compound index `(workspace_id, target_id)` for the panel query.

   Backfill marker matches the existing `block_index_backfill_done`
   pattern in clientSchema.ts (alias backfill landed there), so the
   path for an existing user's local DB to populate is already
   established.

   Estimated effect from the alias-index analogue: backlinks lookup
   drops from O(workspace) to O(matches) — should land at <1 ms even
   for 10k × 50 cases.

3. **(Medium, still open) Cache eviction policy.** ~3 KB JS-heap per
   loaded block + no eviction = unbounded growth. An LRU bounded at,
   say, 50 000 blocks would cap the cache at ~150 MB. Long sessions
   that page through many docs over hours can accumulate well past
   that. Spec §5.2 / §16 list this as undecided; nothing has changed
   here.

   While we're at it, fix the bench so memory measurements are
   reliable — add a `--expose-gc` flag to the bench's vite-node
   invocation and a `global.gc()` before/after the load loop.

4. **(Medium, new) Lightweight metrics counters.** Reviewer's Phase A
   from the previous baseline. Counters in `HandleStore.invalidate`
   (handles-walked, matches-fired), `LoaderHandle.invalidate`
   (re-resolves, loader-runs), `BlockCache.setSnapshot` (dedup
   hits/misses), exposed as `repo.metrics()`.

   Now that follow-up #1 (inverted index) is on the table, doing #4
   first is a quick win: it gives us a way to verify in production
   that the optimisation reduced the walk from N to (matched). The
   bench numbers are anchors; the in-app counters are the regression
   detector.

5. **(Medium, carry-over) `tx.childrenOf` on a wide parent.** 22 ms
   to read 10 000 children inside a tx is real cost when a mutator
   like `insertChildren` does it pre-write. For wide-fan-out workspaces
   (a "tasks" page with 10k tasks under one root) this dominates
   `mutate.createChild` latency. A children-cache or child-count
   short-circuit could help; uncertain whether it's worth it relative
   to other items.

6. **(Low, new) Browser-side React render bench.** All the data-layer
   numbers above are upper bounds on what React can do — the actual
   per-keystroke render count, useEffect retrigger rate, and TTI
   need a Playwright + Profiler harness. Worth timing once the
   in-app metrics counters (#4) are live so we can connect
   "dispatcher invalidates this many handles" to "this many
   components re-render."

7. **(Low, carry-over) Cascade investigation.** `setContent` on a
   chain leaf at depth 100 still fires 6.2 cache notifies (not 1)
   per write. Mostly benign — the `setSnapshot` calls inside ancestor
   re-resolves are idempotent — but worth confirming no
   chain-depth-dependent allocation snuck in.

8. **(Low, carry-over) Bench regression CI.** Once #1–#3 land and
   we have stable numbers, gate CI on >25% p95 regression for the
   headline benches. The runner's JSON output is shaped for that
   already.

---

## Re-running

```bash
# Full default run (no large fixtures):
yarn bench

# A single suite:
yarn bench writes
yarn bench handles

# Multiple, with stable output filename for diffing:
yarn bench writes reads --out tmp/bench-results/baseline.json

# Include the heavy scale variants (50k+ blocks, 10k chains):
yarn bench scale --scale full
```

Suites: `writes`, `reads`, `handles`, `search`, `tail`, `scale`.

Each writes a markdown table to stdout and a JSON file under
`tmp/bench-results/` (defaulting to a timestamped name; pass `--out
path.json` for a fixed name).
