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
