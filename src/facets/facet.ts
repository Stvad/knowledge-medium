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
  })
}

/** Reusable `combine` for an **id-bearing list facet** — one whose
 *  `Input` carries a logical `id` and whose consumers iterate the output
 *  as an array, rendering/keying one element per entry by that id
 *  (`appMountsFacet`, `panelMountsFacet`, `headerItemsFacet`). The
 *  default keep-all combine is WRONG for these: unlike a reference-stable
 *  singleton data/schema extension, mounts are contributed inside plugin
 *  factories, so each call mints a fresh `FacetContribution` and the
 *  resolver's identity dedup (`seen` set in `walkAppExtension`) never
 *  fires. Two code paths contributing the same logical `id` would then
 *  BOTH render — two components, two `addEventListener`s, one dispatch
 *  handled twice (the #64 double-mount trap). This collapses duplicate
 *  `id`s to a single survivor while keeping the output a `readonly
 *  Input[]` — use `keyedMapFacet` instead when the consumer wants a
 *  `ReadonlyMap`.
 *
 *  Tie-break — LAST-WINS, precedence-ordered. `FacetRuntime.read` sorts
 *  contributions ascending by `precedence` (default 0, then registration
 *  order) before calling `combine`, so when two survive with the same
 *  `id` the later one — higher precedence, or later registration at equal
 *  precedence — replaces the earlier. This matches the repo-wide §6
 *  registry convention (`keyedMapFacet`, the effects reconciler in
 *  `liveRuntime.ts`) whose documented override idiom is "register after
 *  to replace"; a silent first-wins would drop that override with no
 *  signal. First-occurrence position is preserved in the output (an
 *  override updates in place rather than moving to the end), so dedup
 *  never reshuffles render order.
 *
 *  A same-`id` collision is a misconfiguration even when the tie-break is
 *  "fine" (it's what made bundling the reschedule-picker mount unsafe in
 *  #63/#64), so each displacement logs a warning naming the facet + id.
 *
 *  NOT appropriate for `actionsFacet` (keyed by `context:id` downstream —
 *  the same id legitimately appears in multiple contexts) or
 *  `appEffectsFacet` (the liveRuntime reconciler already dedups it by id,
 *  because it owns the effect start/stop lifecycle). */
export const dedupById =
  <Input extends {id: string}>(facetId: string) =>
    (values: readonly Input[]): readonly Input[] => {
      const byId = new Map<string, Input>()
      for (const value of values) {
        if (byId.has(value.id)) {
          console.warn(
            `[${facetId}] duplicate contribution for id "${value.id}"; ` +
              'collapsed to a single entry (last-wins per facet convention)',
          )
        }
        byId.set(value.id, value)
      }
      return [...byId.values()]
    }

/** Per-facet identifier for a runtime contribution bucket. Each
 *  subscription owner manages its own bucket; setRuntimeContributions
 *  replaces the bucket for that source id. Static contributions (from
 *  the extension graph) keep the source string they were registered
 *  with — they never share a bucket id with a runtime source. */
export type RuntimeSourceId = string

type FacetChangeListener = () => void

/** NOTE: `LiveRuntimeHandle` (src/extensions/liveRuntime.ts) subclasses
 *  this and overrides EVERY public method to delegate to a swappable
 *  `current` runtime — its inherited storage is intentionally dead. A new
 *  public method added here that the handle doesn't override would
 *  silently serve that empty inherited state for effect callers (no type
 *  error). Add the override there too. */
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
  /** Per-facet set of runtime source ids marked **durable** — i.e.
   *  written with `{durable: true}`. Durable buckets are repo-owned
   *  user data (user property schemas / types) that must survive a
   *  `setFacetRuntime` swap; `adoptDurableContributionsFrom` copies only
   *  these forward onto the fresh runtime. Transient buckets (effect-
   *  owned outputs such as the theme apply-actions or keybinding
   *  overrides) are NOT tracked here — their owning effect re-pushes
   *  them on restart, so replaying them would strand stale entries when
   *  the effect's plugin is toggled off (the bug that reverted the
   *  literal `withContributionsFrom` in #152). */
  private readonly durableRuntimeSources = new Map<string, Set<RuntimeSourceId>>()
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
   *  per-facet subscribers after the cache is invalidated.
   *
   *  `options.durable` (default false) marks the bucket as repo-owned
   *  user data that must survive `setFacetRuntime` swaps — see
   *  `adoptDurableContributionsFrom` / `durableRuntimeSources`. Effect-
   *  owned (transient) writers omit it. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: RuntimeSourceId,
    contributions: readonly Input[],
    options?: { durable?: boolean },
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
      this.unmarkDurable(facet.id, sourceId)
    } else {
      existing.set(sourceId, wrapped)
      this.runtimeContributionsByFacet.set(facet.id, existing)
      if (options?.durable) this.markDurable(facet.id, sourceId)
      else this.unmarkDurable(facet.id, sourceId)
    }
    this.cache.delete(facet.id)
    this.notifyFacetListeners(facet.id)
  }

  private markDurable(facetId: string, sourceId: RuntimeSourceId): void {
    const set = this.durableRuntimeSources.get(facetId) ?? new Set<RuntimeSourceId>()
    set.add(sourceId)
    this.durableRuntimeSources.set(facetId, set)
  }

  private unmarkDurable(facetId: string, sourceId: RuntimeSourceId): void {
    const set = this.durableRuntimeSources.get(facetId)
    if (!set) return
    set.delete(sourceId)
    if (set.size === 0) this.durableRuntimeSources.delete(facetId)
  }

  /** Copy the **durable** runtime-contribution buckets from `previous`
   *  onto this (fresh) runtime, preserving their durability marks, so
   *  repo-owned user data (user property schemas / types) survives a
   *  `setFacetRuntime` swap without a separate Repo-side mirror. This is
   *  the sound realization of B1(2) "make replay the runtime's job":
   *  only durable buckets are carried forward, so transient effect-owned
   *  buckets can't strand. Caches for the touched facets are
   *  invalidated; no listeners fire (a fresh runtime has none yet — the
   *  bridge runs its rebuild steps after this call).
   *
   *  Carry-forward is unconditional, so a writer that owns a workspace-scoped
   *  durable bucket must clear it on teardown (see the ownership contract on
   *  `Repo.setRuntimeContributions`) — otherwise its data is adopted into the
   *  next workspace's runtime on the per-user Repo singleton. */
  adoptDurableContributionsFrom(previous: FacetRuntime): void {
    for (const [facetId, durableSources] of previous.durableRuntimeSources) {
      const prevBuckets = previous.runtimeContributionsByFacet.get(facetId)
      if (!prevBuckets) continue
      for (const sourceId of durableSources) {
        const bucket = prevBuckets.get(sourceId)
        if (!bucket || bucket.length === 0) continue
        const buckets = this.runtimeContributionsByFacet.get(facetId)
          ?? new Map<RuntimeSourceId, FacetContribution<unknown>[]>()
        buckets.set(sourceId, bucket)
        this.runtimeContributionsByFacet.set(facetId, buckets)
        this.markDurable(facetId, sourceId)
        this.cache.delete(facetId)
      }
    }
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
