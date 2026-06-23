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
 * `run` is **async** — `impl`, decorators and observers may return a promise;
 * it awaits the chain, so even an all-sync verb pays one microtask. `runSync`
 * is the synchronous counterpart for a **pure** verb whose contributions are
 * all synchronous: it folds the same decorators over the same impl, fires the
 * same before/after observers (an observer that returns a promise is allowed
 * but fire-and-forget — it never gates the result), re-validates, and returns
 * the result directly with no microtask. A **result-determining** contribution
 * (the impl or a decorator) that returns a promise violates the sync contract
 * and is handled exactly like a throw — i.e. per `onError` (`'fallback'`
 * re-runs the synchronous `defaultImpl`; `'rethrow'` throws). Reach for
 * `runSync` only when the decision is needed at a synchronous boundary (e.g. a
 * DOM `preventDefault`); `run` stays correct — and required — for effectful
 * verbs whose impl/decorators legitimately await.
 */
export type MaybePromise<T> = T | Promise<T>

/** Thenable check. A result-determining contribution that returns one under
 *  `runSync` has gone async, violating the synchronous contract. Robust to
 *  primitives/null (optional chaining short-circuits). */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as {then?: unknown} | null | undefined)?.then === 'function'

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
   *  but without awaiting. Requires every result-determining contribution (the
   *  impl and the decorators) to be synchronous: one that returns a promise
   *  violates the contract and is handled per `onError` (like a throw).
   *  before/after observers may still be async — they fire-and-forget and never
   *  gate the result. For **pure** verbs needed at a synchronous boundary; use
   *  `run` for effectful verbs that legitimately await. */
  runSync: (runtime: VerbRuntime, input: Input) => Result
}

export function defineVerbFacet<Input, Result>({
  id,
  defaultImpl,
  validateResult,
  onError = 'rethrow',
}: {
  id: string
  defaultImpl: VerbImpl<Input, Result>
  /** Optional runtime check on the resolved result. A result that fails it is
   *  treated like a crash (handled per `onError`). Supply this for verbs whose
   *  consumers trust the result shape, since contributions are only validated as
   *  functions, not by their return value. */
  validateResult?: (result: Result) => boolean
  /** What to do when an `impl`/`decorator` throws or returns an invalid result.
   *  `'rethrow'` (default): `run` rejects, the default is never re-executed —
   *  safe for **effectful** verbs (no double-execution). `'fallback'`: re-run
   *  `defaultImpl` — resilient, but only safe for a **pure** verb whose impl is
   *  effect-free-until-return. See the failure-policy note above. */
  onError?: 'fallback' | 'rethrow'
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

  const run = async (runtime: VerbRuntime, input: Input): Promise<Result> => {
    for (const observe of runtime.read(beforeFacet)) {
      try {
        await observe(input)
      } catch (error) {
        console.error(`[verb:${id}] before-observer threw`, error)
      }
    }

    // Resolved OUTSIDE the try so the catch's `ranBareDefault` check can see
    // them. Safe ONLY because these reads are throw-free: the default
    // combine just returns the array, and `implFacet`'s combine is a static
    // `console.warn` + `values.at(-1)` (no plugin-controlled value is
    // stringified). Any resolution-time work on plugin data that COULD throw
    // must move inside the try (as the decorator fold did) — `read` caches
    // only on success, so an escaping combine throw would re-throw every call.
    const impl = runtime.read(implFacet) ?? defaultImpl
    const decorators = runtime.read(decoratorsFacet)

    // Compute the outcome WITHOUT throwing, so `after` can observe every
    // outcome (success, fallback, failure) before we (re)throw at the end.
    let outcome: VerbOutcome<Result>
    try {
      // `read` returns contributions ascending by precedence, so folding
      // left wraps the lowest-precedence decorator around the impl first
      // (innermost) and leaves the highest-precedence one outermost. The
      // fold runs INSIDE the try so a decorator that throws *while wrapping*
      // (not just when its wrapper is called) also degrades to the default.
      let composed: VerbImpl<Input, Result> = impl
      for (const decorate of decorators) {
        composed = decorate(composed)
      }
      const result = await composed(input)
      // A malformed (non-throwing) result is treated like a crash: an
      // untyped plugin can return `undefined`/`{}` past the function-only
      // contribution check, which would otherwise reach consumers (e.g.
      // `decision.kind` read after `preventDefault`) and crash/swallow.
      if (validateResult && !validateResult(result)) {
        throw new Error(`[verb:${id}] impl/decorator returned an invalid result`)
      }
      outcome = {ok: true, result}
    } catch (error) {
      // A throwing-or-malformed impl/decorator is a crash, not a veto. Under
      // `'rethrow'` (default) the error is surfaced and the default is never
      // re-run — the safe policy for an effectful verb (no double-execution).
      // Under `'fallback'` we degrade to the default so one buggy plugin can't
      // break a pure verb; if we already ran exactly the bare default, there's
      // nothing safer to try.
      const ranBareDefault = impl === defaultImpl && decorators.length === 0
      if (onError === 'rethrow' || ranBareDefault) {
        outcome = {ok: false, error}
      } else {
        console.error(
          `[verb:${id}] impl/decorator threw or returned an invalid result; falling back to defaultImpl`,
          error,
        )
        try {
          const result = await defaultImpl(input)
          // The fallback result is validated too — `validateResult` guards THE
          // result, not just a plugin's. A core default that returns an invalid
          // shape is a bug to surface (same stance as a throwing bare default:
          // there's nothing safer to fall back to).
          if (validateResult && !validateResult(result)) {
            throw new Error(`[verb:${id}] defaultImpl returned an invalid result`, {cause: error})
          }
          outcome = {ok: true, result}
        } catch (fallbackError) {
          outcome = {ok: false, error: fallbackError}
        }
      }
    }

    // `after` runs for EVERY outcome (success or failure) — before the rethrow —
    // so balanced before/after observers stay symmetric. Observer errors are
    // isolated so they can't break the verb (or mask the real outcome).
    for (const observe of runtime.read(afterFacet)) {
      try {
        await observe(input, outcome)
      } catch (error) {
        console.error(`[verb:${id}] after-observer threw`, error)
      }
    }

    if (!outcome.ok) throw outcome.error
    return outcome.result
  }

  // The synchronous twin of `run` — same structure, no `await`. Kept as a
  // sibling rather than sharing a core: the await points are exactly what
  // differs, and threading a "sync vs async" flag through the fold/validate
  // would obscure both paths. See the `runSync` contract in the module doc.
  const runSync = (runtime: VerbRuntime, input: Input): Result => {
    // before-observers run synchronously. One that returns a promise is allowed
    // but fire-and-forget — it never gates the (synchronous) result; swallow a
    // sync throw AND an eventual async rejection so it can't break the verb.
    for (const observe of runtime.read(beforeFacet)) {
      try {
        const maybe = observe(input)
        if (isThenable(maybe)) {
          maybe.then(undefined, error =>
            console.error(`[verb:${id}] before-observer (async) rejected`, error))
        }
      } catch (error) {
        console.error(`[verb:${id}] before-observer threw`, error)
      }
    }

    // Resolved outside the try, throw-free — see the matching note in `run`.
    const impl = runtime.read(implFacet) ?? defaultImpl
    const decorators = runtime.read(decoratorsFacet)

    let outcome: VerbOutcome<Result>
    try {
      let composed: VerbImpl<Input, Result> = impl
      for (const decorate of decorators) {
        composed = decorate(composed)
      }
      const result = composed(input)
      // A promise from a result-determining contribution (impl/decorator) means
      // it went async, violating the sync contract — treat it exactly like a
      // crash so `onError` decides (fallback re-runs the sync default).
      if (isThenable(result)) {
        throw new Error(
          `[verb:${id}] runSync requires synchronous contributions, but the impl/decorator returned a promise`,
        )
      }
      if (validateResult && !validateResult(result as Result)) {
        throw new Error(`[verb:${id}] impl/decorator returned an invalid result`)
      }
      outcome = {ok: true, result: result as Result}
    } catch (error) {
      const ranBareDefault = impl === defaultImpl && decorators.length === 0
      if (onError === 'rethrow' || ranBareDefault) {
        outcome = {ok: false, error}
      } else {
        console.error(
          `[verb:${id}] impl/decorator threw, returned an invalid result, or went async; falling back to defaultImpl`,
          error,
        )
        try {
          const result = defaultImpl(input)
          // The sync contract extends to the fallback default: an async default
          // can't satisfy `runSync`, so surface it (same stance as a throwing
          // bare default — there's nothing safer to fall back to).
          if (isThenable(result)) {
            throw new Error(
              `[verb:${id}] runSync requires a synchronous defaultImpl, but it returned a promise`,
              {cause: error},
            )
          }
          if (validateResult && !validateResult(result as Result)) {
            throw new Error(`[verb:${id}] defaultImpl returned an invalid result`, {cause: error})
          }
          outcome = {ok: true, result: result as Result}
        } catch (fallbackError) {
          outcome = {ok: false, error: fallbackError}
        }
      }
    }

    for (const observe of runtime.read(afterFacet)) {
      try {
        const maybe = observe(input, outcome)
        if (isThenable(maybe)) {
          maybe.then(undefined, error =>
            console.error(`[verb:${id}] after-observer (async) rejected`, error))
        }
      } catch (error) {
        console.error(`[verb:${id}] after-observer threw`, error)
      }
    }

    if (!outcome.ok) throw outcome.error
    return outcome.result
  }

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
