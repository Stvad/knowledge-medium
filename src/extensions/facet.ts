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

/** Per-facet identifier for a runtime contribution bucket. Each
 *  subscription owner manages its own bucket; setRuntimeContributions
 *  replaces the bucket for that source id. Static contributions (from
 *  the extension graph) keep the source string they were registered
 *  with — they never share a bucket id with a runtime source. */
export type RuntimeSourceId = string

type FacetChangeListener = () => void

export class FacetRuntime {
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
  await collectContributions(extensions, context, contributions)
  return new FacetRuntime(context, contributions)
}

export function resolveFacetRuntimeSync(
  extensions: AppExtension | readonly AppExtension[],
  context: FacetResolveContext = {},
): FacetRuntime {
  const contributions: FacetContribution<unknown>[] = []
  collectContributionsSync(extensions, contributions)
  return new FacetRuntime(context, contributions)
}

const pushValidatedContribution = (
  contribution: FacetContribution<unknown>,
  output: FacetContribution<unknown>[],
): void => {
  const validate = contribution.facet.validate
  if (validate && !validate(contribution.value)) {
    console.error(
      `Dropping invalid contribution for facet "${contribution.facet.id}"`,
      {source: contribution.source, value: contribution.value},
    )
    return
  }

  output.push(contribution)
}

async function collectContributions(
  extension: AppExtension | readonly AppExtension[],
  context: FacetResolveContext,
  output: FacetContribution<unknown>[],
): Promise<void> {
  if (!extension) return

  if (isExtensionArray(extension)) {
    for (const child of extension) {
      await collectContributions(child, context, output)
    }
    return
  }

  if (typeof extension === 'function') {
    try {
      await collectContributions(await extension(context), context, output)
    } catch (error) {
      console.error('Failed to resolve app extension', error)
    }
    return
  }

  if (extension.type === 'facet-contribution') {
    pushValidatedContribution(extension, output)
  }
}

function collectContributionsSync(
  extension: AppExtension | readonly AppExtension[],
  output: FacetContribution<unknown>[],
): void {
  if (!extension) return

  if (isExtensionArray(extension)) {
    for (const child of extension) {
      collectContributionsSync(child, output)
    }
    return
  }

  if (typeof extension === 'function') {
    throw new Error('Cannot resolve function app extensions synchronously')
  }

  if (extension.type === 'facet-contribution') {
    pushValidatedContribution(extension, output)
  }
}

const isExtensionArray = (
  extension: AppExtension | readonly AppExtension[],
): extension is readonly AppExtension[] => Array.isArray(extension)
