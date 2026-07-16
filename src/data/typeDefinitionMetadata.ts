import type {BlockData} from '@/data/api'
import {BLOCK_TYPE_TYPE} from '@/data/blockTypes'
import {seededDefinitionKey} from '@/data/definitionSeeds'
import {isTypeSeedKey} from '@/data/typeSeeds'
import {
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypeTypeIdProp,
  hasBlockType,
} from '@/data/properties'

/** Codec-less identity/display facts carried by a `block-type` definition row —
 * the type analog of `PropertyDefinitionMetadata`. Property-ref resolution
 * (block-type:properties → live schemas) is behavior and lives elsewhere. */
export interface TypeDefinitionMetadata {
  /** The membership token written into `typesProp` (§9): a seed-valid row's
   *  differing `block-type:type-id` claim, else the block id (user types +
   *  demoted claims). */
  readonly typeId: string
  readonly blockId: string
  readonly workspaceId: string
  readonly createdAt: number
  readonly label: string
  readonly description?: string
  readonly color?: string
  readonly hideFromCompletion: boolean
  readonly hideFromBlockDisplay: boolean
  /** The row's `/type/` seed key — present only when it proves valid TYPE seed
   *  provenance (deterministic-id check + `/type/` grammar). */
  readonly seedKey?: string
  // No `origin` field (unlike PropertyDefinitionMetadata) — no consumer needs it
  // yet. When C2b adds one, do NOT reuse propertySchemaOriginForSeedKey: its
  // `seedKey.indexOf('/property/')` returns -1 for a /type/ key, so slice(0, -1)
  // silently truncates the owner (even 'system:kernel-data' → 'system:kernel-dat')
  // instead of failing. Factor a grammar-aware owner split shared by both kinds.
}

/** Decode a display-only field, degrading a malformed stored value to the
 * field's default instead of throwing. Mirrors `UserTypesService.tryBuildType`'s
 * `safeDisplayProp`: a bad color / hide-flag / optional type-id claim from a raw
 * import, sync, or bridge write must not drop an otherwise-valid type from the
 * registry and pickers — only an absent/empty label rejects the row. */
const safeDecode = <T>(
  row: Pick<BlockData, 'properties'>,
  property: {readonly name: string; readonly codec: {decode(value: unknown): T}; readonly defaultValue: T},
): T => {
  const raw = row.properties[property.name]
  if (raw === undefined) return property.defaultValue
  try {
    return property.codec.decode(raw)
  } catch {
    return property.defaultValue
  }
}

/** The row's own code-seed key IFF it proves TYPE provenance: a valid seeded
 * definition (§4.2 id equation) whose key is a `/type/` key. `seededDefinitionKey`
 * accepts either grammar, so a `block-type` row backed by a `/property/` seed —
 * a dual-typed or imported property-definition row sitting at the shared
 * deterministic id — would otherwise read as a seeded type and surface a property
 * seed key as type metadata; requiring `/type/` here closes that. */
const typeSeedKeyForRow = (row: BlockData): string | undefined => {
  const key = seededDefinitionKey(row)
  return key !== undefined && isTypeSeedKey(key) ? key : undefined
}

/** Parse a `block-type` definition row into codec-less identity/display facts.
 * A deleted, non-block-type, or (after degrading a malformed label to empty)
 * label-less row returns null; malformed DISPLAY fields (color, hide flags,
 * description, a bad optional type-id claim) degrade to defaults rather than
 * dropping the type. The §9 type-id claim rule: a `block-type:type-id` differing
 * from the block's own id is honored only with valid `/type/` seed provenance
 * (`typeSeedKeyForRow`). That check proves the row's id and its own `/type/`
 * `seed:key` are mutually consistent — enough to demote a claim from a row that
 * fails it (a bare/foreign `seed:key`, a `/property/`-backed row, a
 * cross-workspace paste whose `workspace_id` was rewritten, §12). It does NOT
 * prove the key is a real code declaration, so a fully self-consistent forged
 * type seed (correct uuid for an invented `/type/` key) can still emit a
 * competing claim — §9's stated small-fleet residual. That residual is bounded
 * only once the C3 id-keyed registry applies §7 earliest-`createdAt` winner
 * resolution (the early real seed beats a late forgery), and is remediable via
 * §12's enumeration query. Until that registry lands NO consumer honors a
 * differing `typeId` claim: the transitional `UserTypesService` projector keys
 * published contributions by BLOCK id, because the last-wins `typesFacet` has no
 * winner resolution — processed in `created_at ASC` order, a late import would
 * otherwise WIN and hijack a kernel/plugin id (see `userTypesService.ts`). */
export const parseTypeDefinitionMetadata = (
  row: BlockData,
): TypeDefinitionMetadata | null => {
  if (row.deleted) return null
  try {
    if (!hasBlockType(row, BLOCK_TYPE_TYPE)) return null
    const label = safeDecode(row, blockTypeLabelProp)
    if (label.length === 0) return null
    const description = safeDecode(row, blockTypeDescriptionProp)
    const color = safeDecode(row, blockTypeColorProp).trim()
    const hideFromBlockDisplay = safeDecode(row, blockTypeHideFromBlockDisplayProp)
    const hideFromCompletion = safeDecode(row, blockTypeHideFromCompletionProp)

    const seedKey = typeSeedKeyForRow(row)
    const claimedTypeId = safeDecode(row, blockTypeTypeIdProp)
    const typeId = claimedTypeId.length > 0 && claimedTypeId !== row.id && seedKey !== undefined
      ? claimedTypeId
      : row.id

    const base: TypeDefinitionMetadata = {
      typeId,
      blockId: row.id,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      label,
      hideFromCompletion,
      hideFromBlockDisplay,
      ...(description.length > 0 ? {description} : {}),
      ...(color.length > 0 ? {color} : {}),
    }
    return seedKey === undefined ? base : {...base, seedKey}
  } catch {
    return null
  }
}
