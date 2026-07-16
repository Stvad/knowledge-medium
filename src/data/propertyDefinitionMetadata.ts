import {ChangeScope, isChangeScope, type BlockData, type PropertySchemaOrigin} from '@/data/api'
import {PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {seededDefinitionKey} from '@/data/definitionSeeds'
import {isPropertySeedKey} from '@/data/propertySeeds'
import {
  hasBlockType,
  propertyChangeScopeProp,
  propertyHiddenProp,
  propertyNameProp,
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
 * metadata fields return null; a malformed, wrong-id, or non-`/property/`
 * seed marker is the one deliberate exception and demotes to ordinary user
 * provenance. */
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

    // Require PROPERTY provenance. `seededDefinitionKey` now also validates
    // `/type/` rows (a `block-type` block can be a valid seeded definition), so a
    // dual-typed or imported row carrying a `/type/` `seed:key` at the shared
    // deterministic id must NOT read as a seeded property — `propertySchemaOriginForSeedKey`
    // assumes a `/property/` segment and would truncate a `/type/` owner. Demote
    // anything without a valid `/property/` key to ordinary user provenance.
    const seedKey = seededDefinitionKey(row)
    if (seedKey === undefined || !isPropertySeedKey(seedKey)) {
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

    // The validated key proved this `/property/` seed's deterministic id matches
    // the row for its own workspace.
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
