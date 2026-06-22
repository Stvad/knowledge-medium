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
 *   - `afterFacet`      — **Sum**: observers run after, with the result.
 *
 * Intent is encoded by *which slot you contribute to* — there's no tagged
 * contribution union. `run` resolves the four facets against a runtime and
 * executes `before → decorators(impl)(input) → after`.
 *
 * **Failure policy.** A guard ("confirm before X", "veto Y") is a
 * *decorator* that controls whether it calls `next` — i.e. it short-
 * circuits by *returning*, not by throwing. Throwing is treated as a
 * crash, not a veto:
 *   - before/after observers are pure and isolated — their errors are
 *     logged and swallowed so an observer can never break the verb.
 *   - a throwing impl/decorator — or, when `validateResult` is supplied, one
 *     that returns a result failing it — is logged and the verb **falls back
 *     to `defaultImpl(input)`**, so one buggy plugin can't break the verb for
 *     every other consumer. Dynamic-extension code is transpiled without
 *     type-checking and contributions are only validated as functions, so a
 *     plugin with a missing `return` (→ `undefined`) or a malformed object
 *     slips past unless the verb checks its result shape — supply
 *     `validateResult` for any verb whose consumers trust the result shape.
 *     (If `defaultImpl` itself throws, `run` rejects — a core bug to surface.)
 *   - **Side-effect precondition for the fallback:** because the fallback
 *     re-invokes `defaultImpl(input)` after the impl/decorator chain may
 *     have *already partially run*, an `impl`/`decorator` MUST NOT commit
 *     observable side effects before it returns — otherwise a crash
 *     mid-effect re-runs the effect via the default (double execution).
 *     This is trivially true for a pure decision verb like paste; a
 *     side-effectful verb (navigate, dispatch) must keep its impl
 *     effect-free-until-return (e.g. return a *description* of the effect
 *     that the caller applies), or it should not rely on this fallback.
 *   - `after` is therefore **success-only**: it runs with the resolved
 *     result (including a fallback result), but not if `defaultImpl`
 *     throws. Cleanup that must always fire belongs in a decorator's
 *     `try/finally` around `next`, not in an `after` observer.
 *
 * `run` is **async-only** — `impl`, decorators and observers may return a
 * promise, and a sync verb still pays one microtask. That's fine for an
 * async verb like paste, but a sync-ordering-sensitive home (navigation,
 * which today runs synchronously) must account for it before adopting this
 * helper. See the note in `docs/extension-seam-gaps.md`.
 */
export type MaybePromise<T> = T | Promise<T>

export type VerbImpl<Input, Result> = (input: Input) => MaybePromise<Result>

export type VerbDecorator<Input, Result> = (
  next: VerbImpl<Input, Result>,
) => VerbImpl<Input, Result>

export type VerbBefore<Input> = (input: Input) => MaybePromise<void>

export type VerbAfter<Input, Result> = (
  input: Input,
  result: Result,
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
}

export function defineVerbFacet<Input, Result>({
  id,
  defaultImpl,
  validateResult,
}: {
  id: string
  defaultImpl: VerbImpl<Input, Result>
  /** Optional runtime check on the resolved result. A result that fails it
   *  is treated like a crash → fall back to `defaultImpl`. Supply this for
   *  verbs whose consumers trust the result shape, since contributions are
   *  only validated as functions, not by their return value. */
  validateResult?: (result: Result) => boolean
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

    let result: Result
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
      result = await composed(input)
      // A malformed (non-throwing) result is treated like a crash: an
      // untyped plugin can return `undefined`/`{}` past the function-only
      // contribution check, which would otherwise reach consumers (e.g.
      // `decision.kind` read after `preventDefault`) and crash/swallow.
      if (validateResult && !validateResult(result)) {
        throw new Error(`[verb:${id}] impl/decorator returned an invalid result`)
      }
    } catch (error) {
      // A throwing-or-malformed impl/decorator is a crash, not a veto —
      // degrade to the default so one buggy plugin can't break the verb. If
      // we already ran exactly the bare default, there's nothing safer to try.
      const ranBareDefault = impl === defaultImpl && decorators.length === 0
      if (ranBareDefault) throw error
      console.error(
        `[verb:${id}] impl/decorator threw or returned an invalid result; falling back to defaultImpl`,
        error,
      )
      result = await defaultImpl(input)
    }

    for (const observe of runtime.read(afterFacet)) {
      try {
        await observe(input, result)
      } catch (error) {
        console.error(`[verb:${id}] after-observer threw`, error)
      }
    }

    return result
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
  }
}
