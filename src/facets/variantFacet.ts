import {
  defineFacet,
  type Facet,
} from './facet.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * What a variant IS for a given block — everything except which variant
 * it is. Split from the identity above it because identity is a fact
 * about the REGISTRATION (there before any block exists, which is what
 * lets tooling enumerate what is installed) while these are facts about
 * this block: which component draws it, whether it takes the slot, what
 * the resulting row shows.
 */
export interface VariantFacts<Render> {
  render: Render
  /**
   * Take this slot when nothing else is chosen. Default true — a
   * registration that resolves at all normally wants the slot.
   *
   * `false` offers the variant without claiming it: it stays in `all`
   * for a picker and stays reachable by `byId` for an explicit
   * per-block override, but never wins on its own. That is the
   * difference between "I can draw this block if asked" and "this block
   * is mine", which a gate that only answers yes/no cannot express.
   */
  claims?: boolean
  /**
   * Does this fill a block's content slot with OTHER blocks' rows — a review
   * backlog, a review deck, a recents list — rather than drawing the block it
   * was given? Consumers care because such a row's rect describes everything
   * it shows instead of the block, which anything reasoning about row geometry
   * has to know.
   *
   * A fact about the CHOICE, not about the component: put it on the component
   * and every wrapper has to hand it on, which the editing dispatcher — in
   * front of the content renderer for every block in the app — silently did
   * not. Meaningless for slots whose variants aren't content renderers; those
   * simply omit it.
   *
   * `'as-composed'` is for a variant that renders whatever the block's own
   * renderer composed rather than replacing it — the editing dispatcher, which
   * picks between the read and edit slots. Only such a variant may defer; a
   * variant that REPLACES the composed renderer draws its own content, and
   * inheriting the displaced renderer's answer would describe the wrong thing.
   * Omitting it therefore means "not a view", never "ask whoever I displaced".
   */
  showsOtherBlocks?: boolean | 'as-composed'
}

/**
 * A named alternative for a slot, resolved for one block — something a
 * user (or a programmatic gate) can pick between. Variants share a
 * `Render` shape (a renderer, a layout, a configuration object…); the
 * picker UI uses `id` + `label`.
 */
export type Variant<Render> = {
  id: string
  label: string
} & VariantFacts<Render>

/**
 * What a plugin registers: a stable identity plus its facts — either
 * inline (`{id, label, render}`, applies everywhere) or computed per
 * block by `resolve`. Supply exactly one; a registration with neither is
 * rejected by `validate`, and `resolve` wins if both are present.
 *
 * `resolve` returning `null`/`undefined`/`false` means "this variant does
 * not apply here at all" — it drops out of the picker as well as the
 * running. To apply but not take the slot, return facts with
 * `claims: false`.
 */
export interface VariantRegistration<Context, Render> extends Partial<VariantFacts<Render>> {
  id: string
  label: string
  resolve?: (context: Context) => VariantFacts<Render> | null | undefined | false
}

/**
 * What `runtime.read(variantFacet)` resolves to — a function from
 * context to the registered set, plus convenience pickers. Selection
 * itself is intentionally *not* baked into the facet: most useful
 * selections (user prefs, per-block overrides) read reactive state and
 * therefore need to happen in a React component, not inside the
 * facet's cached `combine` step.
 */
export interface VariantSelection<Render> {
  /** Every variant that applies to this context, in precedence order
   *  (lowest precedence first — same order facet contributions are
   *  visited generally). Includes variants that declined to claim the
   *  slot: this is the picker's menu, not the running. */
  all: readonly Variant<Render>[]
  /** Last CLAIMING variant in precedence order. Equivalent to the legacy
   *  `combineLastContributionResult` semantics — the right pick for
   *  facets where contributions self-gate by context. */
  last: Variant<Render> | undefined
  /** First claiming variant in precedence order. Useful as a fallback
   *  when no user-driven selection has been made yet. */
  first: Variant<Render> | undefined
  /** Look up a specific variant by id, claiming or not — this is how an
   *  explicit per-block override reaches a variant that would not have
   *  taken the slot by itself. Returns `undefined` if no contribution
   *  registered that id (e.g. the user's saved preference points at a
   *  removed plugin). */
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

const isVariantRegistration = <Context, Render>(
  value: unknown,
): value is VariantRegistration<Context, Render> =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.label === 'string' &&
  (typeof value.resolve === 'function' || value.render !== undefined)

const factsFor = <Context, Render>(
  registration: VariantRegistration<Context, Render>,
  context: Context,
): VariantFacts<Render> | null => {
  if (registration.resolve) return registration.resolve(context) || null
  return registration.render === undefined ? null : (registration as VariantFacts<Render>)
}

/**
 * Define a facet whose contributions register named alternatives
 * (variants) for a slot. The resolved value enumerates the variants that
 * apply to a block and offers convenience pickers (`last`, `first`,
 * `byId`); the consumer decides which one to render — typically by
 * reading a user preference reactively at render time.
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
}): Facet<VariantRegistration<Context, Render>, VariantResolver<Context, Render>> {
  return defineFacet<
    VariantRegistration<Context, Render>,
    VariantResolver<Context, Render>
  >({
    id,
    combine: registrations => {
      // Same id = same variant, so only one survives: the strongest. That is
      // how an extension overrides a built-in — register `{id: 'layout', …}`
      // at the precedence the built-in holds (later registration takes an
      // equal one) or above, and yours is the layout variant.
      //
      // `registrations` arrives sorted ascending by precedence — registration
      // order is already gone — so the survivor is simply the LAST namesake,
      // and it has to keep the last one's POSITION as well as its value. A
      // plain `Map.set` would keep the first insertion's position, seating an
      // override below variants it outranks and handing `last` to one of
      // them; delete-then-set moves it to the end.
      const byId = new Map<string, VariantRegistration<Context, Render>>()
      for (const registration of registrations) {
        byId.delete(registration.id)
        byId.set(registration.id, registration)
      }
      const deduped = [...byId.values()]

      return context => {
        const all: Variant<Render>[] = []
        for (const registration of deduped) {
          const facts = factsFor(registration, context)
          if (facts) all.push({...facts, id: registration.id, label: registration.label})
        }
        if (all.length === 0) return emptySelection<Render>()
        const resolvedById = new Map<string, Variant<Render>>()
        for (const variant of all) resolvedById.set(variant.id, variant)
        const claiming = all.filter(variant => variant.claims !== false)
        return {
          all,
          first: claiming[0],
          last: claiming[claiming.length - 1],
          byId: (lookup) => (lookup == null ? undefined : resolvedById.get(lookup)),
        }
      }
    },
    empty: () => () => emptySelection<Render>(),
    validate: isVariantRegistration,
  })
}

/**
 * Construct a static registration in a single expression. Sugar for
 * plugins whose variant applies to every block and needs no per-block
 * facts (e.g. `defineVariant('flat', 'Flat', LinkedReferences)` reads
 * more naturally than the object literal). Functionally identical to
 * `{id, label, render}`.
 */
export const defineVariant = <Render>(
  id: string,
  label: string,
  render: Render,
): VariantRegistration<unknown, Render> => ({ id, label, render })
