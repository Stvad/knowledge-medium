# Data-layer perf baseline (post-Phase 2)

Captured against the data-layer redesign at the close of Phase 2 (Sync
`Block` + Handles + React migration; reviewer-fix passes 2.C/2.D
landed). Branch: `data-layer-redesign-phase1-foundations`, commit
`14deace`. Hardware: M-series mac, Node 24.15, `@powersync/node`
worker-thread DB.

The bench harness lives in [scripts/bench/](../scripts/bench). Re-run
with `yarn bench [suite...]` (suites: `writes`, `reads`, `handles`,
`search`, `tail`, `scale`). Raw JSON results are in
[tmp/bench-results/](../tmp/bench-results/).

Each table reports mean / p50 / p95 / p99 in ms, plus per-op SQL
roundtrip counts where applicable (the data-layer-spec §2 goal #7 proxy:
"tree walks push to SQL" — we count to verify nothing leaked back to
JS-side iteration).

---

## Headline findings

1. **§2 goal #7 verified.** `repo.subtree(rootId)` for a tree of
   1365 blocks at depth 5 costs **exactly 1 SQL query** (1
   `getAll(SUBTREE_SQL)`). The recursive CTE is doing its job.

2. **Cold-start "journal page" = 5 SQL roundtrips** for a 51-node
   page (1 load + 4 neighborhood/handle loads). Not 1, not 50 —
   roughly what the design promises.

3. **Single keystroke (`mutate.setContent`)** on a warm leaf takes
   ~0.4 ms median and 5 SQL roundtrips (`UPDATE` + 1 read for
   read-your-own-writes + tx_context set/clear + command_events
   insert). At 50k-block DB it's still 0.32 ms — **no scale
   degradation**.

4. **Multi-mutator tx batching is ~9× faster** than separate
   `repo.mutate.X` calls. Building a 50-node tree:
   - 1 `repo.tx { 50× tx.create }`: **5.4 ms** (1.3 SQL ops/row)
   - 50× `repo.mutate.createChild`: **49.4 ms** (7.2 SQL ops/row)

   The per-row overhead in separate-tx mode is dominated by
   `tx_context` set/clear + `command_events` row + writeTransaction
   open/close. Documenting this so call sites that import a doc
   don't accidentally do N separate mutations.

5. **Tree CTEs flat across depth.** `ANCESTORS_SQL` at depth 10 vs
   5000 takes 0.15 ms vs 0.99 ms — the path-INSTR visited-id check is
   not the bottleneck reviewers feared. The chain itself only matters
   ~6× more for 500× the depth.

6. **`handleStore.invalidate` cost is linear in registered handles**
   (the reviewer's #1 concern). At realistic ranges:

   | registered N |  invalidate (mean) |
   | --- | ---: |
   | 1 | 3 µs |
   | 100 | 9 µs |
   | 1 000 | 37 µs |
   | 10 000 | 222 µs |

   Real-end-to-end impact: a `setContent` write **with 10 000
   bystander handles registered** takes 2.06 ms vs 0.59 ms baseline
   — a **3.5× write-latency degradation**. Worth optimising before
   we expect users to mount thousands of components on one page.

7. **`findBacklinks` is the slowest read path.** At 10k-block
   workspace with 50 refs/block, **mean is 568 ms**, max 661 ms.
   Even at 5 refs/block: 108 ms. The `EXISTS (SELECT 1 FROM
   json_each(references_json))` scan walks every row's references
   array. UI that shows backlinks on every page is going to feel
   this.

8. **Cache memory growth is unbounded** (no eviction). ~3.3 KB
   heap-resident per loaded `BlockData`. 100k blocks ≈ 330 MB. A
   long session that visits many pages will accumulate. Confirms
   reviewer #6.

---

## Suite results

### Writes — `tmp/bench-results/writes-reads.json`

| operation | mean (ms) | p95 | p99 | sql/op | notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `mutate.setContent` (warm leaf) | 0.43 | 0.56 | 2.76 | 5.0 | the keystroke baseline |
| `mutate.createChild` (parent w/ 0 sibs, append) | 0.73 | 0.87 | 6.84 | 6.2 | |
| `mutate.createChild` (parent w/ 100 sibs) | 0.91 | 1.00 | 9.35 | 6.2 | |
| `mutate.createChild` (parent w/ 1000 sibs) | 2.71 | 3.21 | 12.06 | 6.2 | order_key compute walks siblings |
| `mutate.createChild` (1000 sibs, position=first) | 2.73 | 3.27 | 14.83 | 6.2 | front insert similar cost |
| `mutate.insertChildren` (n=50 into 100-wide) | 7.13 | 7.82 | — | 66 | 1.32 sql/row — atomic batch |
| `mutate.insertChildren` (n=500 into 100-wide) | 68.82 | 85.87 | — | 606 | 1.21 sql/row — bulk |
| `mutate.indent` (mid sibling, 100-wide) | 1.03 | 1.15 | 12.46 | 9.9 | indent + outdent alternating |
| `mutate.move` (subtree → depth-100 leaf, cycle-check) | 0.93 | 1.34 | 1.64 | 8.3 | IS_DESCENDANT_OF runs |
| `mutate.delete` (subtree of 50) | 8.90 | 9.86 | — | 19.2 | DFS via tx.childrenOf + per-row UPDATE |
| `repo.tx { 50× tx.create }` (single tx) | **4.98** | 6.42 | — | 64.8 | 1.30 sql/row |
| 50× `mutate.createChild` (50 separate txs) | **43.36** | 49.02 | — | 360 | 7.20 sql/row — per-tx overhead clear |
| 10× `setContent` parallel (`Promise.all`) | 4.21 | 7.22 | 11.61 | 52 | serializes through PowerSync's writeTransaction queue |

### Reads — `tmp/bench-results/writes-reads.json`

| operation | mean (ms) | p95 | sql/op | notes |
| --- | ---: | ---: | ---: | --- |
| `repo.load(id)` cold | 0.062 | 0.087 | 1 | one SELECT |
| `repo.load(id, {children})` 10 ch | 0.16 | 0.39 | 2.4 | |
| `repo.load(id, {children})` 100 ch | 0.42 | 0.56 | 2.4 | |
| `repo.load(id, {children})` 1 000 ch | 2.66 | 2.82 | 2.4 | |
| `repo.load(id, {children})` 10 000 ch | 30.1 | 38.2 | 2.4 | dominated by row serialization |
| `repo.load(id, {ancestors})` depth 10 | 0.20 | 0.40 | 2.4 | |
| `repo.load(id, {ancestors})` depth 100 | 1.39 | 5.10 | 2.4 | |
| `repo.load(id, {ancestors})` depth 1000 | 1.03 | 1.28 | 2.4 | |
| `repo.load(id, {descendants})` n=1111 | 5.67 | 7.03 | 2.4 | |
| `SUBTREE_SQL` raw n=156 | 0.63 | 0.69 | — | |
| `SUBTREE_SQL` raw n=1111 | 4.23 | 4.53 | — | |
| `SUBTREE_SQL` raw n=11111 | 52.3 | 56.3 | — | |
| `ANCESTORS_SQL` raw depth 10 | 0.14 | 0.21 | — | |
| `ANCESTORS_SQL` raw depth 100 | 0.84 | 1.00 | — | flat |
| `ANCESTORS_SQL` raw depth 1000 | 0.84 | 0.92 | — | flat |
| `ANCESTORS_SQL` raw depth 5000 | 0.88 | 1.02 | — | flat |
| `IS_DESCENDANT_OF_SQL` yes (depth 500) | 0.51 | 0.58 | — | full walk |
| `IS_DESCENDANT_OF_SQL` no (depth 500) | 0.058 | 0.082 | — | early miss |
| `CHILDREN_SQL` raw 10 ch | 0.085 | 0.12 | — | |
| `CHILDREN_SQL` raw 1000 ch | 2.04 | 2.43 | — | |
| `CHILDREN_SQL` raw 10000 ch | 19.25 | 26.40 | — | |
| `repo.subtree(id)` cold load (n=341) | 2.03 | 2.29 | 1.2 | |
| `repo.subtree(id).peek()` warm | <0.001 | <0.001 | 0 | identity-stable, no IO |
| **§2 goal #7** subtree(n=1365, depth=5) | — | — | **1** | exactly 1 SQL call ✓ |
| **cold-start** open page (load+subtree+ancestors) | 2.73 | — | 5 | 51-node page |

### Handles — `tmp/bench-results/handles.json`

| operation | mean (ms) | notes |
| --- | ---: | --- |
| `repo.children(id)` identity hit | 0.002 | Map.get + JSON.stringify |
| `handleStore.invalidate` (N=1, 1 match) | 0.003 | |
| `handleStore.invalidate` (N=100, 1 match) | 0.009 | |
| `handleStore.invalidate` (N=1000, 1 match) | 0.037 | |
| `handleStore.invalidate` (N=10000, 1 match) | **0.222** | linear walk |
| `handleStore.invalidate` (N=1000, all match → re-resolve) | 0.494 | spec §9.4 dedup suppresses notifies |
| LoaderHandle cycle (setContent on child → listener) | 0.635 | full end-to-end |
| `BlockCache.setSnapshot` notify (1 sub) | 0.002 | |
| `BlockCache.setSnapshot` notify (100 subs) | 0.003 | |
| `BlockCache.setSnapshot` notify (1000 subs) | 0.008 | |
| `BlockCache.setSnapshot` dedup (fingerprint match) | 0.001 | no notify, no allocation |
| `mutate.setContent` w/ 0 bystander handles | 0.587 | |
| `mutate.setContent` w/ 100 bystanders | 0.575 | noise |
| `mutate.setContent` w/ 1000 bystanders | 0.628 | small but measurable |
| `mutate.setContent` w/ **10 000 bystanders** | **2.057** | **3.5× regression** vs baseline |
| `setContent` leaf, depth=1 chain | 0.704 | 1.2 cache notifies, 1.1 handle fires |
| `setContent` leaf, depth=5 chain | 0.718 | 1.4 / 1.1 |
| `setContent` leaf, depth=25 chain | 0.757 | 2.4 / 1.1 |
| `setContent` leaf, depth=100 chain | 0.897 | 6.2 / 1.1 — cascade grows mildly w/ depth |

### Search — `tmp/bench-results/search.json`

| operation | mean (ms) | p95 | notes |
| --- | ---: | ---: | --- |
| `findBacklinks` (ws=1 000, refs/block=5) | 7.24 | 12.49 | |
| `findBacklinks` (ws=1 000, refs/block=50) | 29.5 | 33.4 | |
| `findBacklinks` (ws=10 000, refs/block=5) | 108 | 195 | |
| `findBacklinks` (ws=10 000, refs/block=50) | **568** | **662** | the big finding |
| `searchBlocksByContent` (ws=1 000) | 0.65 | 1.43 | LIKE substring |
| `searchBlocksByContent` (ws=10 000) | 2.05 | 2.77 | |
| `findBlocksByType` (ws=10k, 1k tagged) | 2.02 | 2.61 | |
| `findBlockByAliasInWorkspace` | 1.01 | 1.19 | |
| `findAliasMatchesInWorkspace` | 1.15 | 1.36 | |
| `getAliasesInWorkspace` (1k distinct) | 1.69 | 1.78 | |
| `findFirstChildByContent` (1000 sibs) | 0.105 | 0.144 | parent_id index does the work |

### Scale — `tmp/bench-results/scale.json`

| operation | mean (ms) | meta |
| --- | ---: | --- |
| `populateFlat` (n=10 000) | 1205 | 8 296 rows/s |
| `mutate.setContent` (DB size 10 000) | 0.39 | unchanged from small DB |
| `repo.load(id)` cold (DB size 10 000) | 0.080 | unchanged |
| `populateFlat` (n=50 000) | 5846 | 8 553 rows/s |
| `mutate.setContent` (DB size 50 000) | 0.32 | **unchanged** |
| `repo.load(id)` cold (DB size 50 000) | 0.063 | **unchanged** |
| `populateLinearChain` (depth 1000) | 100.7 | 9 930 rows/s |
| `ANCESTORS_SQL` leaf depth 1000 | 1.11 | |
| `IS_DESCENDANT_OF_SQL` leaf-of-root depth 1000 | 0.51 | |
| `SUBTREE_SQL` root depth 1000 chain | 0.95 | |
| `populateLinearChain` (depth 5000) | 552.8 | |
| `ANCESTORS_SQL` leaf depth 5000 | 1.30 | minimal growth from depth 1000 |
| `IS_DESCENDANT_OF_SQL` leaf-of-root depth 5000 | 0.59 | minimal growth |
| `SUBTREE_SQL` root depth 5000 chain | 1.20 | minimal growth |
| `populateFanOut` (width=10 000) | 1197 | |
| `mutate.insertChildren` (n=10 at front, 10k sibs) | 24.1 | |
| `tx.childrenOf` (parent has 10k sibs) | 20.6 | row serialization |
| Cache memory growth (N=10 000 loaded) | — | heap +31.8 MB → 3.3 KB/block |
| Cache memory growth (N=50 000 loaded) | — | reading dominated by GC noise; rss +60 MB |

---

## What's NOT covered yet

### Tail suite — DEFERRED

`scripts/bench/bench-tail.ts` exists and is wired to the runner, but
it crashes against this branch's commit because
`src/data/internals/rowEventsTail.ts` calls
`cache.applySyncSnapshot(...)` — a method that lives in the user's
**unstaged** `blockCache.ts` work, not in the committed code at
`14deace`. Re-run after that lands; the bench itself is correct.

### Browser-side perf — out of scope for the node bench

These are the reviewer's Phase C and matter, but require Playwright
+ React profiler:

- React render counts per keystroke (with the cache notify counts
  measured here as the data-layer ceiling, not React's actual render
  cost).
- `useEffect` retrigger rate on the journal page.
- Time-to-interactive on a real daily-note open.
- Long-page scroll perf (5k-block outline).

### Sync upload throughput — out of scope

PowerSync's `powersync_crud` drain is its own beast. We measure the
local invalidation path; not the upload one.

### Soak / long-session

A multi-hour run watching for handle leaks, undo-stack growth, and
cache RSS drift. Worthwhile but deferred — out of scope of "establish
a baseline."

---

## Recommended follow-ups, in priority order

1. **(High) Inverted index in `HandleStore.invalidate`.** Today it's a
   linear scan: O(handles) per commit. At 10k handles a `setContent`
   loses 1.5 ms to the walk, on top of 0.6 ms baseline. A
   per-(kind, key) inverted index turns this into O(matched) — likely
   sub-100 µs even at 50k registered handles. Needed before we ship a
   page that mounts thousands of `useBlockData(...)`-style hooks. Spec
   §9.2 leaves this open; this bench gives the cost number to justify
   the change.

2. **(High) Per-target backlinks index.** `findBacklinks` at 10k
   workspace × 50 refs/block is 568 ms — too slow for a panel that
   refreshes on backlink writes. Either an explicit
   `block_references(source_id, target_id)` join table maintained by
   the parseReferences processor, or `references_text_id` JSON1 index
   trick. Spec §16 mentions deferring this; the number says now.

3. **(Medium) Cache eviction policy.** ~3.3 KB JS-heap per loaded
   block + no eviction = unbounded growth. An LRU bounded at, say,
   50k blocks would cap at ~165 MB. Today's session that opens many
   pages over hours can accumulate well past that. Spec §5.2 / §16
   list this as undecided; this bench gives the per-block growth
   constant.

4. **(Medium) Lightweight metrics counters.** Reviewer's Phase A:
   counters in `HandleStore.invalidate` (handles-walked,
   matches-fired), `LoaderHandle.invalidate` (re-resolves,
   loader-runs), `BlockCache.setSnapshot` (dedup hits/misses),
   surfaced as `repo.metrics()`. With the bench numbers as anchors,
   these would make in-app regressions immediately visible.

5. **(Medium) `tx.childrenOf` on a wide parent.** 21 ms to read 10k
   children inside a tx is a real cost when a mutator like
   `insertChildren` does it pre-write. For wide-fan-out workspaces
   (a "tasks" page with 10k tasks under one root), this dominates
   `mutate.createChild` latency. A children-cache or child-count
   short-circuit could help.

6. **(Low) Cascade investigation.** `setContent` on a chain leaf at
   depth 100 fires 6.2 cache notifies (not 1) per write. Mostly
   benign — the `setSnapshot` calls inside `repo.ancestors` /
   `repo.children` re-resolve loaders are idempotent — but worth
   confirming no chain-depth-dependent allocation snuck in.

7. **(Low) `findBacklinks` JSON parsing cost.** 50 refs/block × 10k
   blocks means 500k JSON.parse calls on the SQLite side. A
   `references_text` denormalised text column with the alias-id pairs
   space-separated would let `LIKE '% id %'` index, but that's a
   schema change.

8. **(Low) Bench regression CI.** Once #1-#3 land and we have a
   stable number, gate CI on >25 % p95 regression for the headline
   benches. The runner's JSON output is shaped for that already.

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
