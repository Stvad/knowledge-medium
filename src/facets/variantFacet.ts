import {
  defineFacet,
  isFunction,
  type Facet,
} from './facet.ts'

/**
 * A named alternative for a slot — something a user (or a programmatic
 * gate) can pick between. Variants share a `Render` shape (a renderer,
 * a layout, a configuration object…); the picker UI uses `id` + `label`.
 */
export interface Variant<Render> {
  id: string
  label: string
  render: Render
}

/**
 * Per-variant contribution. Like other block-interaction contributions,
 * returning `null`/`undefined`/`false` means "this variant does not
 * apply for this context" — useful when a variant is only meaningful
 * for some blocks (e.g. video-player layout only for video blocks).
 */
export type VariantContribution<Context, Render> =
  (context: Context) => Variant<Render> | null | undefined | false

/**
 * What `runtime.read(variantFacet)` resolves to — a function from
 * context to the registered set, plus convenience pickers. Selection
 * itself is intentionally *not* baked into the facet: most useful
 * selections (user prefs, per-block overrides) read reactive state and
 * therefore need to happen in a React component, not inside the
 * facet's cached `combine` step.
 */
export interface VariantSelection<Render> {
  /** All variants that contributed for this context, in precedence
   *  order (lowest precedence first — same order facet contributions
   *  are visited generally). */
  all: readonly Variant<Render>[]
  /** Last variant in precedence order. Equivalent to the legacy
   *  `combineLastContributionResult` semantics — the right pick for
   *  facets where contributions self-gate by context. */
  last: Variant<Render> | undefined
  /** First variant in precedence order. Useful as a fallback when no
   *  user-driven selection has been made yet. */
  first: Variant<Render> | undefined
  /** Look up a specific variant by id. Returns `undefined` if no
   *  contribution registered that id (e.g. the user's saved
   *  preference points at a removed plugin). */
  byId: (id: string | null | undefined) => Variant<Render> | undefined
}

export type VariantResolver<Context, Render> =
  (context: Context) => VariantSelection<Render>

const EMPTY_VARIANTS: readonly Variant<unknown>[] = []

const emptySelection = <Render>(): VariantSelection<Render> => ({
  all: EMPTY_VARIANTS as readonly Variant<Render>[],
  last: undefined,
  first: undefined,
  byId: () => undefined,
})

/**
 * Define a facet whose contributions register named alternatives
 * (variants) for a slot. The resolved value enumerates the registered
 * variants and offers convenience pickers (`last`, `first`, `byId`);
 * the consumer decides which one to render — typically by reading a
 * user preference reactively at render time.
 *
 * Why selection lives in the consumer: most useful selections want to
 * react to a property/preference change (re-render when the user picks
 * a different variant). The facet's `combine` runs once per facet read
 * and is cached, so embedding selection here would either freeze the
 * choice or force every reactive prop to be threaded through
 * `BlockResolveContext` — defeating the resolver-context stability
 * split (see `BlockResolveContext` doc).
 */
export function defineVariantFacet<Context, Render>({
  id,
}: {
  id: string
}): Facet<VariantContribution<Context, Render>, VariantResolver<Context, Render>> {
  return defineFacet<
    VariantContribution<Context, Render>,
    VariantResolver<Context, Render>
  >({
    id,
    combine: contributions => context => {
      const all: Variant<Render>[] = []
      for (const contribution of contributions) {
        const variant = contribution(context)
        if (variant) all.push(variant)
      }
      if (all.length === 0) return emptySelection<Render>()
      const byIdMap = new Map<string, Variant<Render>>()
      for (const variant of all) byIdMap.set(variant.id, variant)
      return {
        all,
        first: all[0],
        last: all[all.length - 1],
        byId: (lookup) => (lookup == null ? undefined : byIdMap.get(lookup)),
      }
    },
    empty: () => () => emptySelection<Render>(),
    validate: isFunction<VariantContribution<Context, Render>>,
  })
}

/**
 * Construct a Variant in a single expression. Sugar for plugins that
 * register a single variant inline (e.g. `defineVariant('flat',
 * 'Flat', LinkedReferences)` reads more naturally than building the
 * object literal). Functionally identical to `{id, label, render}`.
 */
export const defineVariant = <Render>(
  id: string,
  label: string,
  render: Render,
): Variant<Render> => ({ id, label, render })
