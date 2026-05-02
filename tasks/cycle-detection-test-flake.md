# Flaky cycle detection tests in full-suite runs

## Post-mortem

**Root cause (one sentence):** Two compounding races in the row_events tail — `cycleScanSql` reported only `start_id` so a per-row drain could miss its co-conspirator (drain A scans `idList=[A]` against a snapshot where B's parent move hasn't landed yet, finds nothing; drain B with `idList=[B]` reports `[B]` and the `[A,B]` union is never assembled), and `processOnce` ran fire-and-forget so `flushRowEventsTail()` was not a settle barrier — the test's `expect` could fire while pending onChange-driven drains were still in flight, then those drains' `console.warn`s leaked into a later test's `vi.spyOn` and turned a "no cycle" test into a "cycle reported" failure.

**Fix shape:**

- [src/data/internals/treeQueries.ts:`cycleScanSql`](../src/data/internals/treeQueries.ts) — added a `cyclic` CTE that selects the cycle-closing start ids, then the outer query joins back and returns *every* `chain.id` reached from a cyclic start. Column alias stays `start_id` so callers don't change. Now any single drain that catches the closure reports the full cycle, regardless of which member's mutation triggered the drain.
- [src/data/internals/rowEventsTail.ts:`processOnce`](../src/data/internals/rowEventsTail.ts) — replaced the per-call async function with a serialized chain (`chain.then(...)`). All `processOnce` invocations enqueue at the chain tail and never run concurrently. The chain promise returned by `flush()` resolves only after every drain enqueued before it has finished — including any onChange-triggered drains that fired during the caller's preceding writes. Side effect: also closes the lastId-race (two concurrent drains processing the same `id > lastId` row).

**Diff stat:** `2 files changed, 53 insertions(+), 10 deletions(-)`.

**Verification:** 50/50 isolated `yarn test --run src/data/internals/cycleDetection.test.ts`, 25/25 full-suite runs with zero `cycleDetection.test.ts` failures. The other intermittents observed in those 25 runs (`kernelQueries.test.ts > subtree: a new descendant invalidates`, `parseReferencesProcessor.test.ts > re-typing [[foo]]`) use `repo.tx` fast-path plus a `setTimeout(10)` wait — a different family of load-sensitive timer race, unrelated to the row_events tail and out of scope for this brief.

**Things ruled out along the way:** test isolation / parallelism (each `createTestDb` makes a fresh tmpdir, fresh PowerSync, fresh worker pool — no shared resource); reader-snapshot lag from PowerSync's reader pool (initial hypothesis — added a `writeTransaction` wrap, the wrap's *own* lock-acquisition can sneak in *between* test moves so the scan still saw a stale view, dropped that fix); `cycleScanSql`'s missing visited-id guard (depth-100 cap is sufficient, the brief's adjacent comment about "visited-id guard inline" is slightly inaccurate but pre-existing and not in scope).

---

## What you're investigating

Two tests in [src/data/internals/cycleDetection.test.ts](../src/data/internals/cycleDetection.test.ts) intermittently fail when the full suite runs (`yarn test --run`) but pass cleanly when the file is run in isolation:

```
× cycle detection (§4.7) > emits cycleDetected with startIds covering both members of a sync-induced 2-cycle
× cycle detection (§4.7) > does not fire when sync-applied parent_id changes do not close a loop
```

A third test from [src/data/internals/invalidation.test.ts](../src/data/internals/invalidation.test.ts) was also seen failing in the same full-suite run:

```
× row_events tail: sync-applied invalidation > table-dep handle re-resolves on sync-applied write (reviewer P2)
```

This is **pre-existing** — observed on master at commit `98c938f` before any other changes were applied. Reproduces today, intermittent.

The "does not fire" test failure log included this surprising line:

```
- []
+ [
+   [
+     "[Repo] cycleDetected ws=ws-1 startIds=[\"B\"]",
+   ],
+ ]
```

i.e. the test setup made a **non-cyclic** parent move (B under A), but the cycle scanner reported a cycle with start id `B`. Either the bounded cycle scan in [src/data/internals/treeQueries.ts:`cycleScanSql`](../src/data/internals/treeQueries.ts) is producing a false positive, or state from a prior test (different DB / different PowerSync instance / a previous tail's pending drain) leaked into this run.

## What you should *not* do

- **Don't disable the tests.** They cover §4.7 acceptance and are the only end-to-end coverage of the cycle-scan path on the row_events tail. Quarantining them is worse than the flake.
- **Don't increase timeouts as a fix.** If the issue is timing, find the missed `await` / un-awaited cleanup. Bumping a `vi.waitFor` timeout hides root cause.

## How to reproduce

```bash
# Full suite, repeated until it fails (usually 1–3 runs):
for i in 1 2 3 4 5; do
  echo "=== run $i ==="
  yarn test --run 2>&1 | tail -5
done

# Single-file run — should always pass:
yarn test --run src/data/internals/cycleDetection.test.ts

# The pair that was seen failing together — also passes when run alone:
yarn test --run \
  src/data/internals/cycleDetection.test.ts \
  src/data/internals/invalidation.test.ts
```

The flake is full-suite-only, which is the smoking gun: the tests pass on their own, so something else in the suite is causing the failure. Vitest's default config runs files in parallel — that's likely material.

## Things to investigate in priority order

### 1. Test isolation / parallelism

Vitest runs test files in parallel worker pools by default. Each file gets a fresh module graph, but **shared singletons inside an SDK** (PowerSync's connection pool, a process-level worker thread, a static cache in a dependency) can bleed across files.

- Read [vitest.config.ts](../vitest.config.ts) and check the pool config (`poolOptions.threads` / `forks`, `isolate`).
- Run the suite with `--no-isolate` to amplify, then with `--pool=forks --no-fileParallelism` to eliminate. If the flake disappears under serial single-process execution, it's parallelism.
- Check whether [src/data/test/createTestDb.ts](../src/data/test/createTestDb.ts) uses a process-wide tmp dir / port / socket. If two tests acquire the same path under different worker threads, that's the contamination vector.

### 2. The cycle scanner itself

[`cycleScanSql`](../src/data/internals/treeQueries.ts) walks `chain.parent_id = b.id` from each affected id with `chain.depth < 100`. The "false positive on B with parent A" failure suggests either:

- A's `parent_id` got clobbered by another test (e.g. set to `B`) — in which case the scan correctly reports `B → A → B`. Probably a contamination issue, see #1.
- Or the scan's `id IN (?)` start set isn't being filtered to the active tail's `cycleAffectedByWs` bucket correctly. Cross-check against the [cycleScanSql tests in treeQueries.test.ts](../src/data/internals/treeQueries.test.ts) — those cover the SQL in isolation.
- Or the affected-ids set in [`rowEventsTail` drain (§4.7 cycle-scan candidate selection)](../src/data/internals/rowEventsTail.ts) is including stale ids from a prior tx. Look at the `cycleAffectedByWs` map's lifetime — it's allocated per-drain (correct), but the test calls `flushRowEventsTail()` and then the next pass — make sure no per-Repo state is accumulating.

### 3. The third failure (`table-dep handle re-resolves on sync-applied write`)

Different test, but the same pattern: passes alone, fails in full suite. If it shares root cause with #1 (test isolation), one fix covers both. If not, it's a separate `row_events` tail timing issue worth investigating second.

The test (`src/data/internals/invalidation.test.ts`) seeds a `{kind:'table', table:'blocks'}`-dep handle, simulates a sync-applied write via direct SQL with `tx_context.source = NULL`, and waits for the handle to re-resolve. The path is: insert → row_events trigger fires → tail's `db.onChange` fires → drain reads `id > lastId` → fires `handleStore.invalidate` with `tables: ['blocks']`. If the tail's `lastId` watermark was set wrong (e.g. lingering state from a prior test's tail), the new row's id wouldn't satisfy `id > lastId` and the drain wouldn't pick it up.

## What "done" looks like

A 10-run loop of `yarn test --run` passes 10/10 with no test changes that suppress real signal. If the root cause turns out to be parallelism + a real SDK-level shared resource, the fix is either to serialize the affected files (vitest's `sequence.concurrent: false` per-file) or to give each test process a unique resource handle (separate tmp dirs, separate ports, fresh PowerSync connection).

If the root cause is in the cycle scanner / tail logic, the fix is in `treeQueries.ts` / `rowEventsTail.ts` and the test should remain deterministic against the new code path.

## Useful references

- Spec for cycle detection: §4.7 of [tasks/data-layer-redesign.md](data-layer-redesign.md) (search for "4.7" / "cycleDetected").
- Recent context: commits `711c58e Phase 5: wire repo.events.cycleDetected from row_events tail` and `98c938f Drop repo.events pub/sub for cycleDetected — console.warn + tail callback only` — these landed the current shape.
- The `node:sqlite` trigger-only tests in [src/data/internals/clientSchema.test.ts](../src/data/internals/clientSchema.test.ts) don't touch the tail and don't flake — useful as a contrast point for what's stable.

## Report shape

Write a short post-mortem at the top of this file when you're done: root cause in one sentence, fix shape in one paragraph, and the diff stat. If it turns out to be a vitest config knob rather than a code change, document the knob and why.
