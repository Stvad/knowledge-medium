import {describe, expect, it} from 'vitest'
import type {BlockData} from '@/data/api'
import {BLOCK_TYPE_TYPE} from '@/data/blockTypes'
import {propertyDefinitionBlockId, typeDefinitionBlockId} from '@/data/definitionSeeds'
import {parseTypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import {
  addBlockTypeToProperties,
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypeTypeIdProp,
  seedKeyProp,
} from '@/data/properties'

const WS = 'ws-type-definition-metadata'
const TYPE_SEED_KEY = 'system:kernel-data/type/page'

const typeDefinitionRow = (
  properties: Record<string, unknown>,
  overrides: Partial<BlockData> = {},
): BlockData => ({
  id: 'type-block-id',
  workspaceId: WS,
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: addBlockTypeToProperties(properties, BLOCK_TYPE_TYPE),
  references: [],
  createdAt: 42,
  updatedAt: 43,
  userUpdatedAt: 43,
  createdBy: 'user',
  updatedBy: 'user',
  deleted: false,
  ...overrides,
})

describe('parseTypeDefinitionMetadata', () => {
  it('parses a plain user-type row with the block id as its type id', () => {
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
    })

    expect(parseTypeDefinitionMetadata(row)).toEqual({
      typeId: row.id,
      blockId: row.id,
      workspaceId: WS,
      createdAt: 42,
      label: 'Recipe',
      hideFromCompletion: false,
      hideFromBlockDisplay: false,
    })
  })

  it('returns null for an empty/absent label, a deleted row, or a row without block-type membership', () => {
    expect(parseTypeDefinitionMetadata(typeDefinitionRow({
      [blockTypeLabelProp.name]: '',
    }))).toBeNull()
    expect(parseTypeDefinitionMetadata(typeDefinitionRow({}))).toBeNull()
    expect(parseTypeDefinitionMetadata(typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
    }, {deleted: true}))).toBeNull()
    expect(parseTypeDefinitionMetadata({
      ...typeDefinitionRow({[blockTypeLabelProp.name]: 'Recipe'}),
      properties: {[blockTypeLabelProp.name]: 'Recipe'},
    })).toBeNull()
  })

  it('parses hideFromCompletion / hideFromBlockDisplay / description / color when present', () => {
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
      [blockTypeDescriptionProp.name]: 'A cooking recipe',
      [blockTypeColorProp.name]: 'tomato',
      [blockTypeHideFromBlockDisplayProp.name]: true,
      [blockTypeHideFromCompletionProp.name]: true,
    })

    expect(parseTypeDefinitionMetadata(row)).toMatchObject({
      description: 'A cooking recipe',
      color: 'tomato',
      hideFromBlockDisplay: true,
      hideFromCompletion: true,
    })
  })

  it('honors a seed-valid type-id claim differing from the block id', () => {
    const id = typeDefinitionBlockId(WS, TYPE_SEED_KEY)
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Page',
      [seedKeyProp.name]: TYPE_SEED_KEY,
      [blockTypeTypeIdProp.name]: 'page',
    }, {id})

    expect(parseTypeDefinitionMetadata(row)).toMatchObject({
      typeId: 'page',
      blockId: id,
      seedKey: TYPE_SEED_KEY,
    })
  })

  it('demotes a claim when the row id does not satisfy the deterministic formula (a pasted/forged claim)', () => {
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Page',
      [seedKeyProp.name]: TYPE_SEED_KEY,
      [blockTypeTypeIdProp.name]: 'page',
    }, {id: 'random-block-id'})

    const parsed = parseTypeDefinitionMetadata(row)
    expect(parsed).toMatchObject({typeId: 'random-block-id', blockId: 'random-block-id'})
    expect(parsed).not.toHaveProperty('seedKey')
  })

  it('demotes a claim when the stored seed key does not match the id it was minted for', () => {
    const id = typeDefinitionBlockId(WS, TYPE_SEED_KEY)
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Page',
      [seedKeyProp.name]: 'system:kernel-data/type/other',
      [blockTypeTypeIdProp.name]: 'page',
    }, {id})

    const parsed = parseTypeDefinitionMetadata(row)
    expect(parsed).toMatchObject({typeId: id, blockId: id})
    expect(parsed).not.toHaveProperty('seedKey')
  })

  it('treats a claim equal to the block id as no claim at all', () => {
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
      [blockTypeTypeIdProp.name]: 'type-block-id',
    })

    expect(parseTypeDefinitionMetadata(row)).toMatchObject({typeId: row.id})
    expect(parseTypeDefinitionMetadata(row)).not.toHaveProperty('seedKey')
  })

  it('keeps the type when a display-only field is malformed, degrading it to its default', () => {
    // A bad color / hide-flag from a raw import/sync/bridge write must not drop
    // the whole type from registries and pickers (mirrors tryBuildType).
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
      [blockTypeHideFromBlockDisplayProp.name]: {bad: 'value'},
    })
    expect(parseTypeDefinitionMetadata(row)).toMatchObject({
      typeId: row.id,
      label: 'Recipe',
      hideFromBlockDisplay: false,
    })
  })

  it('ignores a malformed optional type-id claim on an unseeded row instead of dropping the type', () => {
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Recipe',
      [blockTypeTypeIdProp.name]: {bad: 'claim'},
    })
    const parsed = parseTypeDefinitionMetadata(row)
    expect(parsed).toMatchObject({typeId: row.id, label: 'Recipe'})
    expect(parsed).not.toHaveProperty('seedKey')
  })

  it('does not honor a type-id claim backed by /property/ seed provenance', () => {
    // isValidSeededDefinition accepts either grammar; a block-type row that is
    // ALSO a valid property-definition row (property seed key at its
    // deterministic property id) must not read as a seeded type or surface a
    // property seed key as type metadata.
    const PROP_KEY = 'system:kernel-data/property/foo'
    const id = propertyDefinitionBlockId(WS, PROP_KEY)
    const row = typeDefinitionRow({
      [blockTypeLabelProp.name]: 'Page',
      [seedKeyProp.name]: PROP_KEY,
      [blockTypeTypeIdProp.name]: 'page',
    }, {id})

    const parsed = parseTypeDefinitionMetadata(row)
    expect(parsed).toMatchObject({typeId: id, blockId: id})
    expect(parsed).not.toHaveProperty('seedKey')
  })
})
