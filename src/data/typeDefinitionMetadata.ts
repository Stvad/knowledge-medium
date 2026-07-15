import type {BlockData} from '@/data/api'
import {BLOCK_TYPE_TYPE} from '@/data/blockTypes'
import {isValidSeededDefinition} from '@/data/definitionSeeds'
import {
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypeTypeIdProp,
  hasBlockType,
  seedKeyProp,
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
  /** Present only when seed provenance passes the deterministic-id check. */
  readonly seedKey?: string
  // No `origin` field (unlike PropertyDefinitionMetadata) — no consumer needs it
  // yet. When C2b adds one, do NOT reuse propertySchemaOriginForSeedKey: its
  // `seedKey.indexOf('/property/')` returns -1 for a /type/ key, so slice(0, -1)
  // silently truncates the owner (even 'system:kernel-data' → 'system:kernel-dat')
  // instead of failing. Factor a grammar-aware owner split shared by both kinds.
}

const decodePresentOrDefault = <T>(
  row: Pick<BlockData, 'properties'>,
  property: {readonly name: string; readonly codec: {decode(value: unknown): T}; readonly defaultValue: T},
): T => {
  const raw = row.properties[property.name]
  return raw === undefined ? property.defaultValue : property.codec.decode(raw)
}

/** Parse a `block-type` definition row into codec-less identity/display facts.
 * Deleted / non-block-type / label-less / malformed rows return null. The §9
 * type-id claim rule: a `block-type:type-id` differing from the block's own id
 * is honored only when the row passes the deterministic seeded-id check
 * (`isValidSeededDefinition`). That check proves the row's id and its own
 * `seed:key` are mutually consistent — enough to demote a claim from a row that
 * FAILS it (a bare `seed:key` at a random id; a cross-workspace paste, whose
 * `workspace_id` is rewritten to the local workspace, §12). It does NOT prove the
 * `seed:key` is a real code declaration, so a fully self-consistent forged seed
 * (correct uuid for an invented key) can still emit a competing claim — §9's
 * stated small-fleet residual, bounded not here but by the registry's §7
 * earliest-`createdAt` winner resolution (C2b: a late forgery loses to the early
 * real seed) and remediable via §12's enumeration query. */
export const parseTypeDefinitionMetadata = (
  row: BlockData,
): TypeDefinitionMetadata | null => {
  if (row.deleted) return null
  try {
    if (!hasBlockType(row, BLOCK_TYPE_TYPE)) return null
    const label = decodePresentOrDefault(row, blockTypeLabelProp)
    if (label.length === 0) return null
    const description = decodePresentOrDefault(row, blockTypeDescriptionProp)
    const color = decodePresentOrDefault(row, blockTypeColorProp).trim()
    const hideFromBlockDisplay = decodePresentOrDefault(row, blockTypeHideFromBlockDisplayProp)
    const hideFromCompletion = decodePresentOrDefault(row, blockTypeHideFromCompletionProp)

    const seeded = isValidSeededDefinition(row)
    const claimedTypeId = decodePresentOrDefault(row, blockTypeTypeIdProp)
    const typeId = claimedTypeId.length > 0 && claimedTypeId !== row.id && seeded
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
    if (!seeded) return base
    const seedKey = seedKeyProp.codec.decode(row.properties[seedKeyProp.name])
    return {...base, seedKey}
  } catch {
    return null
  }
}
