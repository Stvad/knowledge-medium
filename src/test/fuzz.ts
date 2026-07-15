import fc from 'fast-check'

/**
 * Shared run configuration for the fuzz suites (`*.fuzz.test.ts`).
 *
 * The same property code runs in two tiers:
 *
 * - **Smoke** (default — no env vars): small, fixed-seed run that executes as
 *   part of the regular `yarn test` / `yarn run check` gate. Deterministic on
 *   purpose: the gate re-explores the same cases every run, so a pre-existing
 *   bug can only surface in the nightly deep run, never block an unrelated PR.
 * - **Deep** (`FUZZ_RUNS` and/or `FUZZ_TIME_MS` set): fresh random seed each
 *   run, run count / per-property time budget from the env. Used by
 *   `yarn fuzz` locally and the scheduled fuzz workflow in CI.
 *
 * Reproducing a failure: fast-check's assertion error reports the failing
 * `seed`, `path`, and the shrunk counterexample. Re-run with
 *
 *   FUZZ_SEED=<seed> FUZZ_PATH=<path> FUZZ_RUNS=<n> yarn vitest run <file>
 *
 * (`FUZZ_PATH` jumps straight to the counterexample without re-generating.)
 *
 * Deep runs can exceed vitest's 5s default test timeout — the `yarn fuzz`
 * wrapper passes an appropriate `--testTimeout`; do the same for manual runs.
 */

const envInt = (name: string): number | undefined => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${raw}`)
  return n
}

/** Arbitrary but fixed: keeps the smoke tier deterministic across runs. */
const SMOKE_SEED = 20260714

/** Per-test timeout for suites whose single property can consume the
 *  whole deep budget (pass as `it()`'s third argument). A per-test
 *  timeout OVERRIDES vitest's CLI `--testTimeout`, so a hard-coded
 *  value here would silently cap a long nightly pass — derive it from
 *  the same env the budget comes from, with the same headroom
 *  scripts/fuzz.mjs uses (keep the two in sync). fast-check's
 *  `interruptAfterTimeLimit` deadline is absolute and also bounds
 *  shrinking (fc 4.9.0), so the property can't overrun its own budget;
 *  the headroom below only needs to cover the one in-flight case left
 *  running after the interrupt resolves without awaiting it
 *  (docs/fuzzing.md §6), plus setup/teardown/reporting. Replay mode
 *  (`FUZZ_SEED`/`FUZZ_PATH` set with no explicit budget) also gets the
 *  generous ceiling: shrink/replay chains can run long, and a per-test
 *  timeout here would otherwise silently override the `--testTimeout`
 *  the docs tell users to pass for a manual replay. */
export const fuzzTestTimeout = (): number => {
  const timeMs = envInt('FUZZ_TIME_MS')
  if (timeMs !== undefined) return timeMs + 300_000
  // Run-count-driven deep runs have no time bound to derive from.
  if (envInt('FUZZ_RUNS') !== undefined) return 3_600_000
  // Replay mode: no explicit budget, but still needs headroom for a long
  // shrink/replay chain — see docblock above.
  if (envInt('FUZZ_SEED') !== undefined || process.env.FUZZ_PATH) return 3_600_000
  // Smoke: generous headroom over the ~1s budget for CI contention.
  return 60_000
}

export const fuzzParams = <T>(smokeRuns: number): fc.Parameters<T> => {
  const runs = envInt('FUZZ_RUNS')
  const timeMs = envInt('FUZZ_TIME_MS')
  const seed = envInt('FUZZ_SEED')
  const deep = runs !== undefined || timeMs !== undefined
  return {
    // With only a time budget set, let the time limit be the binding constraint.
    numRuns: runs ?? (timeMs !== undefined ? Number.MAX_SAFE_INTEGER : smokeRuns),
    seed: seed ?? (deep ? undefined : SMOKE_SEED),
    path: process.env.FUZZ_PATH || undefined,
    interruptAfterTimeLimit: timeMs,
  }
}
