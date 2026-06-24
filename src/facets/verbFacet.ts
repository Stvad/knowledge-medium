import {
  defineFacet,
  isFunction,
  type Facet,
  type FacetContribution,
  type FacetContributionOptions,
  type FacetRuntime,
} from './facet.ts'

/**
 * `defineVerbFacet` — the decorator/observer helper from
 * `docs/extensibility-axes.md`, built for **verb-shaped** seams: a single
 * typed `(input) => output` function (navigate, paste, dispatch, rank)
 * where plugins variously want to *observe* it, *wrap* it, or *replace*
 * it, and those intents must compose across plugins.
 *
 * It is NOT a replacement for `defineFacet`. Most facets are lists or
 * keyed registries and shouldn't pay for the four-slot structure; reach
 * for this only when there's one output function with a typed signature.
 *
 * A verb bundles four ordinary facets, each with the algebra appropriate
 * to its role (see the algebra table in `extensibility-axes.md`):
 *
 *   - `implFacet`       — **Replace**: pick THE implementation (last-wins;
 *                         a 2nd impl is a misconfiguration, warned once at
 *                         resolution). Falls back to `defaultImpl`.
 *   - `decoratorsFacet` — **Wrap**: middleware. Lower precedence is
 *                         innermost (closest to the impl); higher
 *                         precedence wraps on the outside and runs first.
 *   - `beforeFacet`     — **Sum**: observers run before the impl.
 *   - `afterFacet`      — **Sum**: observers run after, with the outcome
 *                         (success or failure — see the `after` note below).
 *
 * Intent is encoded by *which slot you contribute to* — there's no tagged
 * contribution union. `run` resolves the four facets against a runtime and
 * executes `before → decorators(impl)(input) → after`.
 *
 * **Failure policy (`onError`).** A guard ("confirm before X", "veto Y") is a
 * *decorator* that controls whether it calls `next` — i.e. it short-circuits
 * by *returning*, not by throwing. Throwing is treated as a crash, not a veto.
 * before/after observers are always pure and isolated — their errors are logged
 * and swallowed so an observer can never break the verb. How a throwing (or,
 * when `validateResult` is supplied, invalid-returning) `impl`/`decorator` is
 * handled is set by `onError`:
 *
 *   - `'rethrow'` (**default**): the error is surfaced — `run` rejects, and the
 *     default impl is **never re-executed**. This is the safe policy for an
 *     **effectful** verb (navigate, dispatch): re-running the default after the
 *     impl may have *already partially committed* a side effect would
 *     double-execute it. The caller handles the rejection (e.g. logs + no-ops).
 *   - `'fallback'`: the error is logged and the verb re-runs `defaultImpl(input)`
 *     so one buggy plugin can't break the verb for every other consumer. Only
 *     safe for a **pure** verb (paste's decision): the impl MUST be
 *     effect-free-until-return, since the fallback re-invokes the default after
 *     the chain may have partially run. (If the *bare* default itself throws,
 *     or the fallback default returns a result failing `validateResult`, `run`
 *     rejects either way — a core bug to surface.)
 *
 * Dynamic-extension code is transpiled without type-checking and contributions
 * are only validated as functions, so a plugin with a missing `return`
 * (→ `undefined`) or a malformed object slips past unless the verb checks its
 * result shape — supply `validateResult` for any verb whose consumers trust it.
 *
 * `after` runs for **every outcome** — it receives a `VerbOutcome`: `{ok: true,
 * result}` on success (including a `'fallback'` result) or `{ok: false, error}`
 * on failure, fired just before `run` rejects. Since `before` always runs too,
 * balanced before/after observers (timing, logging, counters) stay symmetric.
 * `after` only *observes*, though — it can't change the result or stop the
 * rejection; cleanup that must mutate the flow belongs in a decorator's
 * `try/finally` around `next`. An observer that throws is logged and swallowed.
 *
 * **Effectful verb that still wants `'fallback'` resilience?** Model `Result`
 * as a *deferred effect* — `impl: input => () => effect` — and have the caller
 * run the returned thunk once. Returning a thunk is itself effect-free, so the
 * decision phase stays fallback-safe while the effect runs exactly once.
 *
 * `run` (async) and `runSync` (sync) share ONE core — `before →
 * decorators(impl)(input) → settle → after → (re)throw`. They differ only in a
 * small strategy: how observers are invoked (awaited vs fire-and-forget) and
 * how the impl's (possibly promised) result is *settled* into the validated
 * outcome. The onError / fallback / validate policy lives in the core once, so
 * it can't drift between the runners (or a future mode).
 *
 * `run` is **async**: `impl`, decorators and observers may return a promise and
 * it awaits the chain, so even an all-sync verb pays one microtask.
 *
 * `runSync` is the synchronous counterpart, for a verb whose result-determining
 * contributions (impl + decorators) are synchronous. It folds the same
 * decorators, fires the same observers (one returning a promise is fire-and-
 * forget — it never gates the result), re-validates, and returns the result
 * directly with no microtask. Two sync modes, fixed at definition time by the
 * `Result` type:
 *   - **decision** (default): a promise from a result-determining contribution
 *     is a contract violation, handled exactly like a throw — per `onError`
 *     (`'fallback'` re-runs the synchronous `defaultImpl`; `'rethrow'` throws).
 *     This is right for a **pure decision** verb whose `Result` is a plain value
 *     (paste/nav-intent), where an async contribution is a bug.
 *   - **passthrough** (`syncResultMayBePromise: true`): a promised result is a
 *     *legitimate* `Result`, returned **verbatim, un-awaited** — for a verb
 *     whose `Result` itself includes a promise the caller fire-and-forgets (e.g.
 *     an action handler returning `void | false | Promise<void>`). Only the sync
 *     path consults the flag; the async `run` awaits everything regardless.
 *     Passthrough is a **`runSync`-only** contract: the verb does NOT await or
 *     catch the returned promise, so its eventual **rejection is the caller's**
 *     to handle (`void Promise.resolve(result).catch(…)`) — `onError` / fallback
 *     and `after`'s `{ok:false}` cover only *synchronous* throws / invalid
 *     results, never the async rejection (`after` sees `{ok:true}` for a result
 *     that later rejects). Don't also call `run` on a passthrough verb expecting
 *     parity: `run` awaits, so it validates the *resolved* value and surfaces a
 *     rejection — not equivalent to `runSync`.
 *
 * Reach for `runSync` only when the decision is needed at a synchronous boundary
 * (e.g. a DOM `preventDefault`); `run` stays correct for verbs that legitimately
 * await downstream.
 */
export type MaybePromise<T> = T | Promise<T>

/** Thenable check. A result-determining contribution that returns one under
 *  `runSync`'s default (decision) mode has gone async, violating the
 *  synchronous contract. Robust to primitives/null (optional chaining
 *  short-circuits). */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as {then?: unknown} | null | undefined)?.then === 'function'

/** Sequence `step` after a possibly-promised `value`: synchronous when `value`
 *  isn't a promise (so `runSync` pays no microtask), chained when it is (so
 *  `run` awaits). A throw in `step` surfaces as a sync throw or a rejection
 *  respectively — exactly how the verb's final re-throw should land in each
 *  mode. This is the one seam that lets `run` and `runSync` share a core. */
const andThen = <A, B>(
  value: MaybePromise<A>,
  step: (value: A) => MaybePromise<B>,
): MaybePromise<B> =>
  isThenable(value) ? (value as Promise<A>).then(step) : step(value as A)

export type VerbImpl<Input, Result> = (input: Input) => MaybePromise<Result>

export type VerbDecorator<Input, Result> = (
  next: VerbImpl<Input, Result>,
) => VerbImpl<Input, Result>

export type VerbBefore<Input> = (input: Input) => MaybePromise<void>

/** The result of a verb run, handed to `after`-observers. `after` runs for
 *  EVERY outcome, so the observer must discriminate on `ok`:
 *    - `{ok: true, result}`  — succeeded (including a `'fallback'` result)
 *    - `{ok: false, error}`  — failed; `run` is about to reject with `error` */
export type VerbOutcome<Result> =
  | {ok: true; result: Result}
  | {ok: false; error: unknown}

export type VerbAfter<Input, Result> = (
  input: Input,
  outcome: VerbOutcome<Result>,
) => MaybePromise<void>

/** The slice of `FacetRuntime` a verb needs — just `read`. Keeps `run`
 *  decoupled from the concrete runtime class, so the live runtime handle
 *  (which subclasses `FacetRuntime`) works without a cast. */
export type VerbRuntime = Pick<FacetRuntime, 'read'>

export interface VerbFacet<Input, Result> {
  id: string
  implFacet: Facet<VerbImpl<Input, Result>, VerbImpl<Input, Result> | undefined>
  decoratorsFacet: Facet<
    VerbDecorator<Input, Result>,
    readonly VerbDecorator<Input, Result>[]
  >
  beforeFacet: Facet<VerbBefore<Input>, readonly VerbBefore<Input>[]>
  afterFacet: Facet<VerbAfter<Input, Result>, readonly VerbAfter<Input, Result>[]>

  /** Contribute THE implementation (Replace — last-wins, highest
   *  precedence). */
  impl: (
    fn: VerbImpl<Input, Result>,
    options?: FacetContributionOptions,
  ) => FacetContribution<VerbImpl<Input, Result>>
  /** Contribute a wrapping decorator (Wrap). */
  decorator: (
    fn: VerbDecorator<Input, Result>,
    options?: FacetContributionOptions,
  ) => FacetContribution<VerbDecorator<Input, Result>>
  /** Contribute a before-observer (Sum). */
  before: (
    fn: VerbBefore<Input>,
    options?: FacetContributionOptions,
  ) => FacetContribution<VerbBefore<Input>>
  /** Contribute an after-observer (Sum). */
  after: (
    fn: VerbAfter<Input, Result>,
    options?: FacetContributionOptions,
  ) => FacetContribution<VerbAfter<Input, Result>>

  /** Resolve the four facets against `runtime` and run the verb:
   *  `before → decorators(impl)(input) → after`. */
  run: (runtime: VerbRuntime, input: Input) => Promise<Result>

  /** Resolve the four facets against `runtime` and run the verb
   *  **synchronously** — the same `before → decorators(impl)(input) → after`,
   *  but without awaiting. By default (decision mode) every result-determining
   *  contribution (impl + decorators) must be synchronous: one that returns a
   *  promise violates the contract and is handled per `onError` (like a throw).
   *  With `syncResultMayBePromise` (passthrough mode) a promised result is a
   *  legitimate value, returned verbatim and un-awaited. before/after observers
   *  may always be async — they fire-and-forget and never gate the result. For
   *  verbs needed at a synchronous boundary; use `run` to await downstream. */
  runSync: (runtime: VerbRuntime, input: Input) => Result
}

export function defineVerbFacet<Input, Result>({
  id,
  defaultImpl,
  validateResult,
  onError = 'rethrow',
  syncResultMayBePromise = false,
}: {
  id: string
  defaultImpl: VerbImpl<Input, Result>
  /** Optional runtime check on the resolved result. A result that fails it is
   *  treated like a crash (handled per `onError`). Supply this for verbs whose
   *  consumers trust the result shape, since contributions are only validated as
   *  functions, not by their return value. NB for a `syncResultMayBePromise`
   *  (passthrough) verb this runs on DIFFERENT values by runner: the un-awaited
   *  promise under `runSync`, but the resolved value under `run` — so it must
   *  accept both forms (typically: allow a thenable). */
  validateResult?: (result: Result) => boolean
  /** What to do when an `impl`/`decorator` throws or returns an invalid result.
   *  `'rethrow'` (default): `run` rejects, the default is never re-executed —
   *  safe for **effectful** verbs (no double-execution). `'fallback'`: re-run
   *  `defaultImpl` — resilient, but only safe for a **pure** verb whose impl is
   *  effect-free-until-return. See the failure-policy note above. */
  onError?: 'fallback' | 'rethrow'
  /** Selects `runSync`'s **passthrough** mode (default `false` = decision mode).
   *  Set it ONLY when the verb's `Result` legitimately includes a promise that
   *  the caller fire-and-forgets (e.g. an action handler returning
   *  `void | false | Promise<void>`): then `runSync` returns a promised result
   *  verbatim instead of treating it as a sync-contract violation. Leave it
   *  `false` for a pure **decision** verb whose `Result` is a plain value, where
   *  an async contribution really is a bug. The async `run` never consults it.
   *  This is a **`runSync`-only** contract: the verb neither awaits nor catches
   *  the returned promise, so its eventual rejection is the caller's to handle
   *  (`void Promise.resolve(result).catch(…)`); `onError` / fallback and `after`
   *  cover only synchronous throws / invalid results, never the async rejection
   *  (`after` sees `{ok:true}` for a result that later rejects). */
  syncResultMayBePromise?: boolean
}): VerbFacet<Input, Result> {
  // Resolve the impl in `combine` (runs once per facet resolution, then
  // cached) rather than in `run` — this dedups the multiple-impl warning to
  // once-per-resolution instead of once-per-call, matching the registry-
  // facet convention (`keyedMapFacet`, `dedupById`).
  const implFacet = defineFacet<VerbImpl<Input, Result>, VerbImpl<Input, Result> | undefined>({
    id: `${id}.impl`,
    combine: values => {
      if (values.length > 1) {
        console.warn(
          `[verb:${id}] ${values.length} impl contributions; last-wins ` +
            '(highest precedence). Use a decorator to compose, not a second impl.',
        )
      }
      return values.at(-1)
    },
    empty: () => undefined,
    validate: isFunction<VerbImpl<Input, Result>>,
  })
  const decoratorsFacet = defineFacet<VerbDecorator<Input, Result>>({
    id: `${id}.decorators`,
    validate: isFunction<VerbDecorator<Input, Result>>,
  })
  const beforeFacet = defineFacet<VerbBefore<Input>>({
    id: `${id}.before`,
    validate: isFunction<VerbBefore<Input>>,
  })
  const afterFacet = defineFacet<VerbAfter<Input, Result>>({
    id: `${id}.after`,
    validate: isFunction<VerbAfter<Input, Result>>,
  })

  // ── Shared runner core ──────────────────────────────────────────────────
  // `run` and `runSync` are thin shells over `runCore`, which holds the whole
  // `before → fold(decorators, impl) → settle → validate → after → (re)throw`
  // skeleton — including the onError/fallback/validate policy — exactly once. A
  // `RunStrategy` injects the only two things that actually differ: how
  // observers are invoked, and how a (possibly-promised) result is *settled*.
  type Outcome = VerbOutcome<Result>

  interface RunStrategy {
    /** Invoke a phase's observers. async: await each sequentially. sync: call
     *  each and fire-and-forget any promise it returns (never gates the
     *  result). Observer errors are isolated either way. */
    observe: <F>(
      observers: readonly F[],
      invoke: (observer: F) => MaybePromise<void>,
      phase: 'before' | 'after',
    ) => MaybePromise<void>
    /** Run `produce` (the decorator fold + impl call) and hand its result to
     *  `validate` — the one injected seam. `produce`/`validate` throwing (and,
     *  async, a rejected result) all route to `onError`, which is total. */
    settleResult: (
      produce: () => MaybePromise<Result>,
      validate: (result: Result) => Outcome,
      onError: (error: unknown) => MaybePromise<Outcome>,
    ) => MaybePromise<Outcome>
  }

  const asyncStrategy: RunStrategy = {
    observe: async (observers, invoke, phase) => {
      for (const observer of observers) {
        try {
          await invoke(observer)
        } catch (error) {
          console.error(`[verb:${id}] ${phase}-observer threw`, error)
        }
      }
    },
    // await the result, then validate; a rejected result and a validate-throw
    // both route to onError.
    settleResult: async (produce, validate, onError) => {
      try {
        return validate(await produce())
      } catch (error) {
        return onError(error)
      }
    },
  }

  const observeSync: RunStrategy['observe'] = (observers, invoke, phase) => {
    for (const observer of observers) {
      try {
        const maybe = invoke(observer)
        if (isThenable(maybe)) {
          maybe.then(undefined, error =>
            console.error(`[verb:${id}] ${phase}-observer (async) rejected`, error))
        }
      } catch (error) {
        console.error(`[verb:${id}] ${phase}-observer threw`, error)
      }
    }
  }

  // decision mode: a promised result means a contribution went async, violating
  // the sync contract — treat it like a crash so `onError` decides.
  const settleResultSyncStrict: RunStrategy['settleResult'] = (produce, validate, onError) => {
    try {
      const result = produce()
      if (isThenable(result)) {
        // We discard the promise and fall back. Attach a handler first so that
        // an async contribution which also REJECTS is logged (like a rejecting
        // async observer) rather than surfacing as an unhandled rejection — the
        // contract violation itself is handled by the throw → onError below.
        result.then(undefined, error =>
          console.error(`[verb:${id}] discarded async contribution (runSync contract violation) rejected`, error))
        throw new Error(
          `[verb:${id}] runSync requires synchronous contributions, but the impl/decorator returned a promise`,
        )
      }
      return validate(result as Result)
    } catch (error) {
      return onError(error)
    }
  }

  // passthrough mode (`syncResultMayBePromise`): a promised result is a
  // legitimate `Result`, validated and returned verbatim, never awaited.
  const settleResultSyncPassthrough: RunStrategy['settleResult'] = (produce, validate, onError) => {
    try {
      return validate(produce() as Result)
    } catch (error) {
      return onError(error)
    }
  }

  const syncStrategy: RunStrategy = {
    observe: observeSync,
    settleResult: syncResultMayBePromise ? settleResultSyncPassthrough : settleResultSyncStrict,
  }

  const runCore = (
    runtime: VerbRuntime,
    input: Input,
    strategy: RunStrategy,
  ): MaybePromise<Result> => {
    const validate = (result: Result): Outcome => {
      // A malformed (non-throwing) result is treated like a crash: an untyped
      // plugin can return `undefined`/`{}` past the function-only contribution
      // check, which would otherwise reach consumers (e.g. `decision.kind` read
      // after `preventDefault`) and crash/swallow.
      if (validateResult && !validateResult(result)) {
        throw new Error(`[verb:${id}] impl/decorator returned an invalid result`)
      }
      return {ok: true, result}
    }

    // before → … . `andThen` keeps this synchronous under `runSync` (observe
    // returns void) and awaited under `run` (observe returns a promise).
    return andThen(
      strategy.observe(runtime.read(beforeFacet), observer => observer(input), 'before'),
      () => {
        // Resolved AFTER before-observers (matching the original order) and
        // OUTSIDE settleResult's try: these reads are throw-free (the default
        // combine returns the array; `implFacet`'s is a static warn + `at(-1)`),
        // so a bad combine would surface rather than silently fall back, and the
        // `ranBareDefault` check can see them.
        const impl = runtime.read(implFacet) ?? defaultImpl
        const decorators = runtime.read(decoratorsFacet)
        const ranBareDefault = impl === defaultImpl && decorators.length === 0

        const onFailure = (error: unknown): MaybePromise<Outcome> => {
          // A throwing/malformed/contract-violating impl/decorator is a crash,
          // not a veto. Under `'rethrow'` (or once we've run exactly the bare
          // default) surface it; under `'fallback'` re-run the default through
          // the SAME strategy, so the sync/async + validate rules apply
          // identically. A buggy plugin then can't break a pure verb.
          if (onError === 'rethrow' || ranBareDefault) return {ok: false, error}
          console.error(
            `[verb:${id}] impl/decorator threw, returned an invalid result, or violated the sync contract; falling back to defaultImpl`,
            error,
          )
          return strategy.settleResult(
            () => defaultImpl(input),
            result => {
              // The fallback result is validated too — a core default returning
              // an invalid shape is a bug to surface (same stance as a throwing
              // bare default: nothing safer to fall back to).
              if (validateResult && !validateResult(result)) {
                throw new Error(`[verb:${id}] defaultImpl returned an invalid result`, {cause: error})
              }
              return {ok: true, result}
            },
            // The bare default already ran — nothing safer remains, so a
            // fallback failure becomes the surfaced outcome.
            fallbackError => ({ok: false, error: fallbackError}),
          )
        }

        // Compute the outcome WITHOUT throwing, so `after` can observe every
        // outcome (success, fallback, failure) before we (re)throw. The fold
        // runs inside `produce` (i.e. inside settleResult's try) so a decorator
        // that throws *while wrapping* also degrades, not just one that throws
        // when its wrapper is called.
        const outcome = strategy.settleResult(
          () => {
            // `read` returns contributions ascending by precedence, so folding
            // left wraps the lowest-precedence decorator innermost and leaves
            // the highest-precedence one outermost.
            let composed: VerbImpl<Input, Result> = impl
            for (const decorate of decorators) composed = decorate(composed)
            return composed(input)
          },
          validate,
          onFailure,
        )

        // `after` runs for EVERY outcome — before the rethrow — so balanced
        // before/after observers stay symmetric. Observer errors are isolated.
        return andThen(outcome, settled =>
          andThen(
            strategy.observe(runtime.read(afterFacet), observer => observer(input, settled), 'after'),
            () => {
              if (!settled.ok) throw settled.error
              return settled.result
            },
          ))
      },
    )
  }

  const run = async (runtime: VerbRuntime, input: Input): Promise<Result> =>
    runCore(runtime, input, asyncStrategy)

  const runSync = (runtime: VerbRuntime, input: Input): Result =>
    runCore(runtime, input, syncStrategy) as Result

  return {
    id,
    implFacet,
    decoratorsFacet,
    beforeFacet,
    afterFacet,
    impl: (fn, options) => implFacet.of(fn, options),
    decorator: (fn, options) => decoratorsFacet.of(fn, options),
    before: (fn, options) => beforeFacet.of(fn, options),
    after: (fn, options) => afterFacet.of(fn, options),
    run,
    runSync,
  }
}
