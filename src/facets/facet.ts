export interface FacetResolveContext {
  [key: string]: unknown
}

export interface Facet<Input, Output = readonly Input[]> {
  id: string
  combine: (values: readonly Input[], context: FacetResolveContext) => Output
  empty: (context: FacetResolveContext) => Output
  validate?: (value: unknown) => value is Input
  of: (value: Input, options?: FacetContributionOptions) => FacetContribution<Input>
}

export interface FacetContributionOptions {
  precedence?: number
  source?: string
  /** Dragged-along AppExtension subtree. Contributed iff the parent
   *  contribution itself survives validation + any enclosing togglable
   *  boundary. Use this when a sibling contribution exists *because of*
   *  this one — e.g. an action that only makes sense when its renderer
   *  contribution is also live, or a property-editor override that
   *  only fires when its schema is registered. The resolver evaluates
   *  parent-acceptance before recursing here, so an invalid or
   *  filtered-out parent silently drops everything below. */
  enables?: AppExtension
}

export interface FacetContribution<Input> extends FacetContributionOptions {
  type: 'facet-contribution'
  facet: Pick<Facet<Input, unknown>, 'id' | 'validate'>
  value: Input
}

export type AppExtension =
  | FacetContribution<unknown>
  | readonly AppExtension[]
  | ((context: FacetResolveContext) => AppExtension | Promise<AppExtension>)
  | null
  | undefined
  | false

export type FacetFunction = (...args: never[]) => unknown

export const isFunction = <T extends FacetFunction>(
  value: unknown,
): value is T => typeof value === 'function'

export type OptionalContributionResult<T> = T | null | undefined | false

export const resolveLastContributionResult = <Context, Result>(
  contributions: readonly ((context: Context) => OptionalContributionResult<Result>)[],
  context: Context,
  initialValue?: Result,
): Result | undefined => {
  let result = initialValue

  for (const contribution of contributions) {
    const contributionResult = contribution(context)
    if (contributionResult) result = contributionResult
  }

  return result
}

export const combineLastContributionResult =
  <Context, Result>(getInitialValue?: (context: Context) => Result | undefined) =>
    (contributions: readonly ((context: Context) => OptionalContributionResult<Result>)[]) =>
      (context: Context): Result | undefined =>
        resolveLastContributionResult(contributions, context, getInitialValue?.(context))

export function defineFacet<Input, Output = readonly Input[]>({
  id,
  combine,
  empty,
  validate,
}: {
  id: string
  combine?: (values: readonly Input[], context: FacetResolveContext) => Output
  empty?: (context: FacetResolveContext) => Output
  validate?: (value: unknown) => value is Input
}): Facet<Input, Output> {
  const facet: Facet<Input, Output> = {
    id,
    combine: combine ?? ((values) => values as unknown as Output),
    empty: empty ?? (() => [] as unknown as Output),
    validate,
    of: (value, options = {}) => ({
      type: 'facet-contribution',
      facet: facet as unknown as Facet<Input, unknown>,
      value,
      ...options,
    }),
  }

  return facet
}

/** Define a facet whose contributions fold into a `ReadonlyMap` keyed
 *  by `keyOf`. Duplicate keys log a last-wins warning (tagged with the
 *  facet id) and the later contribution wins — the §6 registry
 *  convention shared by every data-layer registry facet (mutators,
 *  queries, types, presets, …). See `src/data/facets.ts`. */
export function keyedMapFacet<Input>(
  id: string,
  keyOf: (value: Input) => string,
  validate?: (value: unknown) => value is Input,
): Facet<Input, ReadonlyMap<string, Input>> {
  return defineFacet<Input, ReadonlyMap<string, Input>>({
    id,
    combine: (values) => {
      const out = new Map<string, Input>()
      for (const value of values) {
        const key = keyOf(value)
        if (out.has(key)) {
          console.warn(
            `[${id}] duplicate registration for "${key}"; last-wins per facet convention`,
          )
        }
        out.set(key, value)
      }
      return out
    },
    empty: () => new Map(),
    validate,
  })
}

/** Per-facet identifier for a runtime contribution bucket. Each
 *  subscription owner manages its own bucket; setRuntimeContributions
 *  replaces the bucket for that source id. Static contributions (from
 *  the extension graph) keep the source string they were registered
 *  with — they never share a bucket id with a runtime source. */
export type RuntimeSourceId = string

type FacetChangeListener = () => void

export class FacetRuntime {
  // Both maps are keyed by `facet.id` (a string), NOT by the Facet
  // object — so `.get(actionsFacet)` from outside this class will
  // return undefined; use `.get(actionsFacet.id)` if you must reach
  // in. Better: agent-side introspection of "what's registered" should
  // go through `describe-runtime` / `contributionsById` / `read`,
  // which already index by id and don't depend on object identity
  // across module instances.
  private readonly staticContributionsByFacet = new Map<string, FacetContribution<unknown>[]>()
  private readonly runtimeContributionsByFacet = new Map<
    string,
    Map<RuntimeSourceId, FacetContribution<unknown>[]>
  >()
  private readonly cache = new Map<string, unknown>()
  private readonly facetListeners = new Map<string, Set<FacetChangeListener>>()

  constructor(
    public readonly context: FacetResolveContext,
    contributions: readonly FacetContribution<unknown>[],
  ) {
    for (const contribution of contributions) {
      const bucket = this.staticContributionsByFacet.get(contribution.facet.id) ?? []
      bucket.push(contribution)
      this.staticContributionsByFacet.set(contribution.facet.id, bucket)
    }
  }

  private collectContributions(facetId: string): FacetContribution<unknown>[] {
    const stat = this.staticContributionsByFacet.get(facetId) ?? []
    const runtime = this.runtimeContributionsByFacet.get(facetId)
    if (!runtime || runtime.size === 0) return stat
    const out: FacetContribution<unknown>[] = [...stat]
    for (const bucket of runtime.values()) out.push(...bucket)
    return out
  }

  read<Input, Output>(facet: Facet<Input, Output>): Output {
    if (this.cache.has(facet.id)) {
      return this.cache.get(facet.id) as Output
    }

    const contributions = this.collectContributions(facet.id)
    if (!contributions.length) {
      const emptyValue = facet.empty(this.context)
      this.cache.set(facet.id, emptyValue)
      return emptyValue
    }

    const values = contributions
      .toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
      .map((contribution) => contribution.value as Input)

    const value = facet.combine(values, this.context)
    this.cache.set(facet.id, value)
    return value
  }

  /** Replace the runtime contributions bucket for this facet under
   *  `sourceId`. Empty `contributions` removes the bucket. Notifies
   *  per-facet subscribers after the cache is invalidated. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: RuntimeSourceId,
    contributions: readonly Input[],
  ): void {
    const wrapped = contributions.map(value => ({
      type: 'facet-contribution' as const,
      facet: facet as unknown as Facet<unknown, unknown>,
      value: value as unknown,
      source: sourceId,
    } satisfies FacetContribution<unknown>))

    const existing = this.runtimeContributionsByFacet.get(facet.id) ?? new Map<RuntimeSourceId, FacetContribution<unknown>[]>()
    if (wrapped.length === 0) {
      existing.delete(sourceId)
      if (existing.size === 0) this.runtimeContributionsByFacet.delete(facet.id)
      else this.runtimeContributionsByFacet.set(facet.id, existing)
    } else {
      existing.set(sourceId, wrapped)
      this.runtimeContributionsByFacet.set(facet.id, existing)
    }
    this.cache.delete(facet.id)
    this.notifyFacetListeners(facet.id)
  }

  /** Subscribe to changes for one facet. Fires after every
   *  setRuntimeContributions call that targets this facet. Static
   *  extension contributions don't fire this — they only change when
   *  the whole runtime is rebuilt. */
  onFacetChange(facetId: string, listener: FacetChangeListener): () => void {
    const set = this.facetListeners.get(facetId) ?? new Set<FacetChangeListener>()
    set.add(listener)
    this.facetListeners.set(facetId, set)
    return () => {
      const current = this.facetListeners.get(facetId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.facetListeners.delete(facetId)
    }
  }

  private notifyFacetListeners(facetId: string): void {
    const listeners = this.facetListeners.get(facetId)
    if (!listeners) return
    for (const l of [...listeners]) {
      try { l() } catch (err) { console.error(`[FacetRuntime] facet listener for ${facetId} threw`, err) }
    }
  }

  contributions<Input>(facet: Facet<Input, unknown>): FacetContribution<Input>[] {
    return this.collectContributions(facet.id) as FacetContribution<Input>[]
  }

  /**
   * Every facet id that has at least one contribution (static or
   * runtime). Useful for introspection (agent bridge describeRuntime,
   * debug pages).
   */
  facetIds(): string[] {
    const ids = new Set<string>()
    for (const id of this.staticContributionsByFacet.keys()) ids.add(id)
    for (const id of this.runtimeContributionsByFacet.keys()) ids.add(id)
    return Array.from(ids)
  }

  /**
   * Raw contributions for a facet, looked up by id rather than by
   * facet object. Lets introspection callers enumerate without
   * needing the original Facet definition in scope.
   */
  contributionsById(facetId: string): FacetContribution<unknown>[] {
    return this.collectContributions(facetId)
  }
}

export async function resolveFacetRuntime(
  extensions: AppExtension | readonly AppExtension[],
  context: FacetResolveContext = {},
): Promise<FacetRuntime> {
  const contributions: FacetContribution<unknown>[] = []
  await walkAppExtension(extensions, contributions, collectVisitor, {context})
  return new FacetRuntime(context, contributions)
}

export function resolveFacetRuntimeSync(
  extensions: AppExtension | readonly AppExtension[],
  context: FacetResolveContext = {},
): FacetRuntime {
  const contributions: FacetContribution<unknown>[] = []
  walkAppExtensionSync(extensions, contributions, collectVisitor, {
    onFunction: 'Cannot resolve function app extensions synchronously',
  })
  return new FacetRuntime(context, contributions)
}

/** Validate a contribution against its facet's `validate` guard and, if
 *  it passes, append it to `output`. Returns whether it was accepted —
 *  the boundary-aware resolver uses the result to decide whether to
 *  recurse into the contribution's `enables` subtree. */
export const pushValidatedContribution = (
  contribution: FacetContribution<unknown>,
  output: FacetContribution<unknown>[],
): boolean => {
  const validate = contribution.facet.validate
  if (validate && !validate(contribution.value)) {
    console.error(
      `Dropping invalid contribution for facet "${contribution.facet.id}"`,
      {source: contribution.source, value: contribution.value},
    )
    return false
  }

  output.push(contribution)
  return true
}

/** Bare collector visitor: append every valid contribution and never
 *  recurse into `enables`. This is the historical, togglable-blind
 *  semantics of the facet.ts collectors — there's no `array` hook, so
 *  togglable boundaries are walked like any other array. Callers that
 *  need toggle boundaries go through `resolveAppRuntime` instead. */
const collectVisitor: AppExtensionVisitor<FacetContribution<unknown>[]> = {
  contribution: (node, output) => {
    pushValidatedContribution(node, output)
    return null
  },
}

// ──────────────────────────────────────────────────────────────────────
// Unified AppExtension walker
// ──────────────────────────────────────────────────────────────────────

/** Runtime type guard for a FacetContribution leaf. Shared by every
 *  AppExtension walk (collector, boundary-aware resolver, toggle
 *  discovery, dynamic loader) so the grammar's leaf shape is recognised
 *  in exactly one place. */
export const isFacetContribution = (
  value: unknown,
): value is FacetContribution<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as {type?: unknown}).type === 'facet-contribution'

const isExtensionArray = (
  extension: AppExtension | readonly AppExtension[],
): extension is readonly AppExtension[] => Array.isArray(extension)

/**
 * Per-site policy for `walkAppExtension` / `walkAppExtensionSync`.
 *
 * The grammar recursion (array, function, contribution, nullish) is
 * fixed; only these two hooks vary across the bare collector, the
 * boundary-aware resolver, and toggle-tree discovery. `C` is the
 * threaded accumulator/target — an output array for the collectors and
 * resolver, a `ToggleNode[]` sink for discovery.
 */
export interface AppExtensionVisitor<C> {
  /** Visit an array node before descending. Return `null` to prune the
   *  subtree, or the context to thread into its children. Omitted ⇒
   *  descend with the parent context unchanged. The togglable-aware
   *  walks read the boundary marker here — facet.ts stays ignorant of
   *  togglable.ts; that policy is injected by the caller. */
  array?: (node: readonly AppExtension[], ctx: C) => C | null
  /** Visit a FacetContribution leaf. Return `null` to skip its
   *  `enables` subtree, or the context to walk `enables` with. */
  contribution: (node: FacetContribution<unknown>, ctx: C) => C | null
}

export interface WalkAppExtensionOptions {
  context: FacetResolveContext
  /** De-duplicate contributions by identity across the whole walk.
   *  Needed when `enables` edges can reach the same contribution by
   *  more than one path (the resolver). */
  seen?: Set<FacetContribution<unknown>>
}

export interface WalkAppExtensionSyncOptions {
  /** Error message thrown when a function-valued node is reached — sync
   *  walks can't await. Call-site-specific so the thrown message names
   *  the offending entry point. */
  onFunction: string
  seen?: Set<FacetContribution<unknown>>
}

/** Async walk over the AppExtension grammar — awaits function-valued
 *  nodes (e.g. the dynamic-extensions loader) and logs + recovers if one
 *  rejects, so a single bad subtree can't abort the whole resolution. */
export async function walkAppExtension<C>(
  node: AppExtension | readonly AppExtension[],
  ctx: C,
  visitor: AppExtensionVisitor<C>,
  options: WalkAppExtensionOptions,
): Promise<void> {
  if (!node) return

  if (typeof node === 'function') {
    try {
      await walkAppExtension(await node(options.context), ctx, visitor, options)
    } catch (error) {
      console.error('Failed to resolve app extension', error)
    }
    return
  }

  if (isExtensionArray(node)) {
    const childCtx = visitor.array ? visitor.array(node, ctx) : ctx
    if (childCtx === null) return
    for (const child of node) {
      await walkAppExtension(child, childCtx, visitor, options)
    }
    return
  }

  if (isFacetContribution(node)) {
    const {seen} = options
    if (seen) {
      if (seen.has(node)) return
      seen.add(node)
    }
    const enablesCtx = visitor.contribution(node, ctx)
    if (enablesCtx !== null && node.enables) {
      await walkAppExtension(node.enables, enablesCtx, visitor, options)
    }
  }
}

/** Sync walk over the AppExtension grammar — throws on function-valued
 *  nodes (the static extension tree has none, and first-paint resolution
 *  can't await). */
export function walkAppExtensionSync<C>(
  node: AppExtension | readonly AppExtension[],
  ctx: C,
  visitor: AppExtensionVisitor<C>,
  options: WalkAppExtensionSyncOptions,
): void {
  if (!node) return

  if (typeof node === 'function') {
    throw new Error(options.onFunction)
  }

  if (isExtensionArray(node)) {
    const childCtx = visitor.array ? visitor.array(node, ctx) : ctx
    if (childCtx === null) return
    for (const child of node) {
      walkAppExtensionSync(child, childCtx, visitor, options)
    }
    return
  }

  if (isFacetContribution(node)) {
    const {seen} = options
    if (seen) {
      if (seen.has(node)) return
      seen.add(node)
    }
    const enablesCtx = visitor.contribution(node, ctx)
    if (enablesCtx !== null && node.enables) {
      walkAppExtensionSync(node.enables, enablesCtx, visitor, options)
    }
  }
}
