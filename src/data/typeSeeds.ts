import type {AnyPropertySchema} from './api/propertySchema'
import type {TypeContribution} from './api/blockType'

/** A code-owned block-type definition. The declaration is ALSO the
 * `TypeContribution` registered into `typesFacet` during the Slice-C
 * transitional window; extensions additionally contribute it to
 * `typeSeedsFacet` for materialization + workspace-bound identity.
 *
 * Mirrors `PropertySeedDeclaration`. The property analogy is exact but for one
 * axis: a property's membership token is its `name` and its per-workspace
 * backing-block id is derived separately; a type's membership token is its `id`
 * (written verbatim into `typesProp`) and stays workspace-agnostic, while the
 * deterministic per-workspace backing block is `typeDefinitionBlockId(ws,
 * seedKey)`. So `id` is NEVER the block id — same split as name vs fieldId. */
export interface TypeSeedDeclaration extends TypeContribution {
  readonly seedKey: string
  readonly revision: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Type seed keys use a `/type/` path segment, disjoint from property
 * `/property/` keys (see `isPropertySeedKey`) so both can share one
 * deterministic-id namespace without collision. */
export const isTypeSeedKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[^/]+\/type\/[^/]+$/.test(value)

export interface SeedTypeArgs {
  readonly seedKey: string
  readonly revision: number
  /** Stable, workspace-agnostic membership id written into `typesProp`
   *  (e.g. `'page'`). The analog of a property seed's `name`. */
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly hideFromCompletion?: boolean
  readonly hideFromBlockDisplay?: boolean
  readonly color?: string
  readonly properties?: ReadonlyArray<AnyPropertySchema>
}

/** Runtime boundary for public/dynamic type-seed contributions. Enforces the
 * constructor's required-field invariants (and additionally type-checks the
 * optional fields `seedType` itself leaves unvalidated) so one malformed
 * contribution is dropped before it can abort a shared materialization pass
 * (`isPropertySeedDeclaration`'s type twin). */
export const isTypeSeedDeclaration = (value: unknown): value is TypeSeedDeclaration =>
  isRecord(value) &&
  typeof value.id === 'string' && value.id.trim().length > 0 &&
  typeof value.label === 'string' && value.label.trim().length > 0 &&
  isTypeSeedKey(value.seedKey) &&
  Number.isInteger(value.revision) && (value.revision as number) > 0 &&
  (value.description === undefined || typeof value.description === 'string') &&
  (value.hideFromCompletion === undefined || typeof value.hideFromCompletion === 'boolean') &&
  (value.hideFromBlockDisplay === undefined || typeof value.hideFromBlockDisplay === 'boolean') &&
  (value.color === undefined || typeof value.color === 'string') &&
  (value.properties === undefined || Array.isArray(value.properties))

/** Define a seeded block type. Unlike `seedProperty` there is no codec/preset to
 * round-trip, so validation is purely structural. The returned declaration is a
 * `TypeContribution` (its `id` is the membership token) carrying stable code
 * provenance (`seedKey`/`revision`) for identity + materialization. Absent
 * optional `TypeContribution` fields (`description`, `hideFromCompletion`, …) are
 * omitted rather than stored as `undefined`, matching the presence/absence a
 * hand-written `defineBlockType({…})` call would have for those same fields — but
 * the seed ALWAYS additionally carries `seedKey`/`revision`, two provenance keys
 * a bare `defineBlockType` never has. So the `TypeContribution` *subset* is a
 * drop-in match; the whole returned object is NOT byte-identical, and any
 * full-object structural compare during the `typesFacet.of` migration (C4) must
 * ignore `seedKey`/`revision`. */
export const seedType = (args: SeedTypeArgs): TypeSeedDeclaration => {
  if (!isTypeSeedKey(args.seedKey)) {
    throw new Error('[seedType] seedKey must match <owner>/type/<stable-key>')
  }
  if (!args.id.trim()) throw new Error('[seedType] id is required')
  if (!args.label.trim()) throw new Error('[seedType] label is required')
  if (!Number.isInteger(args.revision) || args.revision <= 0) {
    throw new Error('[seedType] revision must be a positive integer')
  }
  return {
    id: args.id,
    label: args.label,
    seedKey: args.seedKey,
    revision: args.revision,
    ...(args.description !== undefined ? {description: args.description} : {}),
    ...(args.hideFromCompletion !== undefined ? {hideFromCompletion: args.hideFromCompletion} : {}),
    ...(args.hideFromBlockDisplay !== undefined ? {hideFromBlockDisplay: args.hideFromBlockDisplay} : {}),
    ...(args.color !== undefined ? {color: args.color} : {}),
    ...(args.properties !== undefined ? {properties: args.properties} : {}),
  }
}
