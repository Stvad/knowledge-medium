import {ChangeScope, isChangeScope, type BlockData, type PropertySchemaOrigin} from '@/data/api'
import {PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {isValidSeededDefinition} from '@/data/definitionSeeds'
import {
  hasBlockType,
  propertyChangeScopeProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
} from '@/data/properties'

/** Codec-less facts carried by every usable property-definition row.
 * Behavior (preset/codec/default construction) deliberately lives elsewhere. */
export interface PropertyDefinitionMetadata {
  readonly fieldId: string
  readonly workspaceId: string
  readonly createdAt: number
  readonly name: string
  readonly changeScope: ChangeScope
  readonly hidden: boolean
  readonly origin: PropertySchemaOrigin
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

export const propertySchemaOriginForSeedKey = (seedKey: string): PropertySchemaOrigin => {
  const owner = seedKey.slice(0, seedKey.indexOf('/property/'))
  return owner === 'system:kernel-data' ? 'kernel' : `plugin:${owner}`
}

/** Parse block-readable definition facts without consulting the preset
 * registry. Non-definition/deleted/nameless rows and rows with malformed
 * metadata fields return null; a malformed or wrong-id seed marker is the
 * one deliberate exception and demotes to ordinary user provenance. */
export const parsePropertyDefinitionMetadata = (
  row: BlockData,
): PropertyDefinitionMetadata | null => {
  if (row.deleted) return null

  try {
    if (!hasBlockType(row, PROPERTY_SCHEMA_TYPE)) return null
    const name = decodePresentOrDefault(row, propertyNameProp)
    if (name.length === 0) return null
    const changeScope = decodePresentOrDefault(row, propertyChangeScopeProp)
    // Enum decode is deliberately membership-lenient for historical stored
    // strings; definition metadata still requires one of the real tx scopes.
    if (!isChangeScope(changeScope)) return null
    const hidden = decodePresentOrDefault(row, propertyHiddenProp)

    if (!isValidSeededDefinition(row)) {
      return {
        fieldId: row.id,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt,
        name,
        changeScope,
        hidden,
        origin: 'user',
      }
    }

    // isValidSeededDefinition already proved this field decodes as a valid
    // property seed and satisfies the row's workspace/id equation.
    const seedKey = seedKeyProp.codec.decode(row.properties[seedKeyProp.name])
    return {
      fieldId: row.id,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      name,
      changeScope,
      hidden,
      origin: propertySchemaOriginForSeedKey(seedKey),
      seedKey,
    }
  } catch {
    return null
  }
}
