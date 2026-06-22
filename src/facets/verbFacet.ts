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
 *   - `implFacet`       — **Replace**: pick THE implementation (last-wins).
 *                         Falls back to `defaultImpl` when none registered.
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
 * The runner is async-first: `impl`, decorators and observers may return a
 * promise. A guard ("confirm before X", "veto Y") is a *decorator* (it
 * controls whether it calls `next`); before/after are pure observers and
 * cannot change the result — their errors are isolated so an observer can
 * never break the verb.
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
  implFacet: Facet<VerbImpl<Input, Result>, readonly VerbImpl<Input, Result>[]>
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
}: {
  id: string
  defaultImpl: VerbImpl<Input, Result>
}): VerbFacet<Input, Result> {
  const implFacet = defineFacet<VerbImpl<Input, Result>>({
    id: `${id}.impl`,
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

    const impls = runtime.read(implFacet)
    if (impls.length > 1) {
      console.warn(
        `[verb:${id}] ${impls.length} impl contributions; last-wins ` +
          '(highest precedence). Use a decorator to compose, not a second impl.',
      )
    }
    const impl = impls.at(-1) ?? defaultImpl

    // `read` returns contributions ascending by precedence, so folding
    // left wraps the lowest-precedence decorator around the impl first
    // (innermost) and leaves the highest-precedence one outermost.
    let composed: VerbImpl<Input, Result> = impl
    for (const decorate of runtime.read(decoratorsFacet)) {
      composed = decorate(composed)
    }

    const result = await composed(input)

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
