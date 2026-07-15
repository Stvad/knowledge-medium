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
 * (`isValidSeededDefinition`); otherwise the type projects under its block id —
 * a fabricated or cross-workspace-pasted claim can't squat a seed's type id. */
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
