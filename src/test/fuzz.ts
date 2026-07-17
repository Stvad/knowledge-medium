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

/**
 * Fixed-seed, fixed-count parameters for a property QUARANTINED from the deep
 * tier. Unlike `fuzzParams`, this ignores the deep-tier env
 * (`FUZZ_RUNS`/`FUZZ_TIME_MS`/`FUZZ_SEED`) so the property runs the SAME
 * bounded, deterministic sample in every tier — including the nightly deep run.
 *
 * Use this ONLY when a property trips an ENGINE-level bug (not a product bug and
 * not a wrong oracle — diagnose first, per docs/fuzzing.md) whose every deep-tier
 * hit would otherwise flip the nightly red on something we can't fix from here.
 * The caller MUST cite the tracking issue and the un-quarantine condition. This
 * is deliberately narrow: it trades a property's deep-tier exploration for a
 * green signal, so it should be rare and always reversible.
 */
export const quarantinedFuzzParams = <T>(runs: number): fc.Parameters<T> => ({
  numRuns: runs,
  seed: SMOKE_SEED,
})

/**
 * Seeded-LCG pin over `Math.random`, try/finally restored. The only
 * nondeterminism most stateful suites' target code has (order-key jitter
 * via `fractional-indexing-jittered`) — pinning it makes fast-check's
 * shrinking and seed replay sound. Same constants (48271 / 2147483647)
 * every suite has hand-rolled; kept here so replays of pre-existing
 * seeds produce the identical sequence.
 */
export const withPinnedRandom = async <T>(seed: number, fn: () => Promise<T>): Promise<T> => {
  let lcg = seed
  const realRandom = Math.random
  Math.random = () => {
    lcg = (lcg * 48271) % 2147483647
    return lcg / 2147483647
  }
  try {
    return await fn()
  } finally {
    Math.random = realRandom
  }
}

/**
 * Interrupt-barrier + pin for a stateful fuzz suite sharing mutable state
 * (a DB, patched `Math.random`) across fast-check cases — see
 * docs/fuzzing.md §6. fast-check's `interruptAfterTimeLimit` resolves
 * `fc.assert` WITHOUT awaiting the case currently executing, so an
 * abandoned case can keep running — and writing to the shared state —
 * after the property (or even the whole file) "finishes".
 *
 * Two structural guarantees this owns so suites don't have to re-derive
 * them per file:
 *  - barrier-before-pin: `run()` always awaits the previous in-flight
 *    case BEFORE pinning `Math.random` for the new one, so an abandoned
 *    case's `finally` (which restores `Math.random`) can never land
 *    after — and clobber — the next case's pin. This matters even
 *    within a single suite whenever more than one property or a
 *    non-property test can touch the shared state (multiple `fc.assert`
 *    properties in one file; a canary `it` after the fuzzed one).
 *  - last-case leak: a suite's `afterAll` must call `guard.barrier()` so
 *    an interrupted FINAL case can't leave `Math.random` patched (or
 *    still writing to a shared DB) after the file's tests finish.
 *
 * `seed: null` skips the pin (for cases with no nondeterminism to pin —
 * e.g. a suite with no DB/order-key jitter in its op set); the barrier
 * still applies.
 */
export const statefulFuzzGuard = (): {
  barrier: () => Promise<void>
  run: <T>(seed: number | null, body: () => Promise<T>) => Promise<T>
} => {
  let inFlightCase: Promise<unknown> | null = null
  const barrier = async (): Promise<void> => {
    await inFlightCase?.catch(() => {})
  }
  const run = <T>(seed: number | null, body: () => Promise<T>): Promise<T> => {
    // Register the new case SYNCHRONOUSLY, with the previous-case wait
    // folded inside it: if this case is itself abandoned while still
    // waiting on its predecessor, a later `barrier()` must await it too —
    // registering only after the wait would let it slip past the barrier
    // and resume against shared state during cleanup.
    const prev = inFlightCase
    const casePromise = (async () => {
      await prev?.catch(() => {})
      return seed === null ? body() : withPinnedRandom(seed, body)
    })()
    inFlightCase = casePromise
    return casePromise
  }
  return {barrier, run}
}
