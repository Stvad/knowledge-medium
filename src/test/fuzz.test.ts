/**
 * Unit tests pinning `statefulFuzzGuard` itself (`./fuzz.ts`) — the
 * interrupt-barrier + `Math.random`-pin mechanism every stateful
 * `*.fuzz.test.ts` suite wraps its case body in (docs/fuzzing.md §6).
 * The stateful suites only exercise it indirectly (through real fc runs
 * against a real DB); this file pins its two structural guarantees
 * directly and deterministically, no `fc`/DB required:
 *
 *  - **synchronous registration**: `run()` sets `inFlightCase` to the new
 *    case's promise BEFORE awaiting the previous case, so a case that the
 *    caller never awaits (fast-check's `interruptAfterTimeLimit` resolves
 *    `fc.assert` without awaiting the in-flight case, per the guard's own
 *    docblock) is still the thing a later `barrier()` waits on.
 *  - **barrier-before-pin**: a new case's `Math.random` pin (via
 *    `withPinnedRandom`) is installed only AFTER the previous case's body
 *    *and* its `finally` (which restores `Math.random`) have both
 *    completed — so the previous case's restore can never land after,
 *    and clobber, the new case's pin.
 *  - **`seed: null`**: skips the pin entirely (`Math.random` untouched)
 *    but the case still participates in the barrier chain.
 *
 * Plain deferred promises stand in for "a case that's still running" —
 * no fake timers, no `fc`, so these tests are fast and fully
 * deterministic.
 */
import { describe, expect, it } from 'vitest'
import { statefulFuzzGuard } from '@/test/fuzz'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return {promise, resolve}
}

/** Drains pending microtasks so promise-chain continuations inside the
 *  guard (the `await prev?.catch(...)` hop, then the synchronous
 *  pin-and-call-body that follows it) have run before the next
 *  assertion. A few extra flushes beyond what's structurally needed are
 *  harmless no-ops once the chain is quiescent. */
const flush = async (times = 5): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('statefulFuzzGuard', () => {
  it('a case abandoned while awaiting its predecessor is still awaited by a later barrier() (synchronous registration)', async () => {
    const guard = statefulFuzzGuard()
    const a = createDeferred<void>()
    const b = createDeferred<void>()

    // Neither `run()` call is awaited directly here — mirroring how
    // fast-check's `interruptAfterTimeLimit` resolves `fc.assert` without
    // awaiting the case currently executing (the guard's own docblock,
    // and docs/fuzzing.md §6): the caller moves on without ever awaiting
    // these promises itself.
    void guard.run(1, () => a.promise)
    // B is registered while A is still pending. If registration were
    // deferred until after awaiting A, a `barrier()` called right now
    // could resolve having only ever seen A (or nothing at all) — B must
    // become `inFlightCase` SYNCHRONOUSLY inside this call.
    void guard.run(2, () => b.promise)

    let barrierSettled = false
    const barrierPromise = guard.barrier().then(() => { barrierSettled = true })

    await flush()
    expect(barrierSettled, 'barrier must not resolve while A is still pending').toBe(false)

    a.resolve()
    await flush()
    expect(barrierSettled, 'barrier must not resolve while B (chained after A) is still pending').toBe(false)

    b.resolve()
    await barrierPromise
    expect(barrierSettled, 'barrier resolves once both A and B have settled').toBe(true)
  })

  it('a new pin is installed only after the predecessor\'s body AND finally have both completed (barrier-before-pin)', async () => {
    const guard = statefulFuzzGuard()
    const nativeRandom = Math.random
    const a = createDeferred<void>()
    const b = createDeferred<void>()

    // A has no predecessor — `run()` still suspends at its internal
    // `await prev?.catch(...)` (even with `prev` null, `await undefined`
    // yields a microtask) before pinning, so a flush is needed before A's
    // pin is observable.
    void guard.run(101, () => a.promise)
    await flush()
    const pinnedDuringA = Math.random
    expect(pinnedDuringA, 'starting a case with no predecessor pins once its internal await resolves').not.toBe(nativeRandom)

    // Register B while A is still in flight (unresolved, unrestored).
    const promiseB = guard.run(202, () => b.promise)
    // Still synchronous with the two `run()` calls above — no await has
    // happened yet, so B cannot have reached its own `withPinnedRandom`
    // call. If it had (a broken barrier-before-pin), `Math.random` would
    // already have changed here.
    expect(Math.random, "B must not have pinned yet — A hasn't resolved").toBe(pinnedDuringA)

    a.resolve()
    await flush()

    const pinnedDuringB = Math.random
    expect(pinnedDuringB, "B's pin only takes effect once A's promise (body + finally) settles")
      .not.toBe(pinnedDuringA)

    // The clobbering hazard this guarantee prevents: if B had captured
    // "the real Math.random" (to restore to later) BEFORE A's `finally`
    // ran, it would have captured A's still-patched pin instead of the
    // true original — so B's own eventual restore would leak A's pin
    // (or, symmetrically, A's later restore would stomp B's pin while
    // B's case is still running). Deterministically replaying the LCG
    // `withPinnedRandom` documents (`lcg = (lcg * 48271) % 2147483647`,
    // `./fuzz.ts`) confirms B's stream started fresh from seed 202, not
    // from some state inherited off A's still-active pin.
    let lcg = 202
    const expected = Array.from({length: 3}, () => {
      lcg = (lcg * 48271) % 2147483647
      return lcg / 2147483647
    })
    expect([Math.random(), Math.random(), Math.random()], "B's pin follows seed 202's LCG exactly")
      .toEqual(expected)

    b.resolve()
    await promiseB
    expect(Math.random, 'restored to the true native Math.random once B settles — no leaked pin')
      .toBe(nativeRandom)
  })

  it('seed: null skips the Math.random pin but the case still barriers behind its predecessor', async () => {
    const guard = statefulFuzzGuard()
    const nativeRandom = Math.random
    const a = createDeferred<void>()
    const b = createDeferred<void>()
    let bodyBStarted = false

    const promiseA = guard.run(null, () => a.promise)
    expect(Math.random, 'seed: null must never touch Math.random').toBe(nativeRandom)

    const promiseB = guard.run(303, () => {
      bodyBStarted = true
      return b.promise
    })
    // The barrier chain doesn't care whether A pinned anything — B must
    // still wait for A's promise to settle before its body runs.
    expect(bodyBStarted, "B's body must not run before the null-seeded A settles").toBe(false)
    expect(Math.random, 'Math.random stays untouched while the null-seeded A is in flight').toBe(nativeRandom)

    a.resolve()
    await flush()

    expect(bodyBStarted, "B's body ran once A settled — a null seed still barriers").toBe(true)
    expect(Math.random, 'B pins normally despite A having skipped pinning entirely').not.toBe(nativeRandom)

    b.resolve()
    await promiseB
    await promiseA
    expect(Math.random, 'restored once B settles').toBe(nativeRandom)

    // Sanity: barrier() itself resolves promptly once every case (pinned
    // or not) has settled — the exact pattern every suite's `afterAll`
    // relies on.
    await guard.barrier()
  })
})
