import {describe, expect, it} from 'vitest'
import {ChangeScope, type BlockData} from '@/data/api'
import {PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {parsePropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {
  addBlockTypeToProperties,
  presetIdProp,
  propertyChangeScopeProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
} from '@/data/properties'

const WS = 'ws-definition-metadata'

const definitionRow = (
  properties: Record<string, unknown>,
  overrides: Partial<BlockData> = {},
): BlockData => ({
  id: 'definition-id',
  workspaceId: WS,
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: addBlockTypeToProperties(properties, PROPERTY_SCHEMA_TYPE),
  references: [],
  createdAt: 42,
  updatedAt: 43,
  userUpdatedAt: 43,
  createdBy: 'user',
  updatedBy: 'user',
  deleted: false,
  ...overrides,
})

describe('parsePropertyDefinitionMetadata', () => {
  it('parses a user definition independently of preset availability and applies absent defaults', () => {
    const row = definitionRow({
      [propertyNameProp.name]: 'custom:field',
      [presetIdProp.name]: 'plugin:not-installed',
    })

    expect(parsePropertyDefinitionMetadata(row)).toEqual({
      fieldId: row.id,
      workspaceId: WS,
      createdAt: 42,
      name: 'custom:field',
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: 'user',
    })
  })

  it.each([
    ['system:kernel-data/property/title', 'kernel'],
    ['plugin:calendar/property/event-date', 'plugin:plugin:calendar'],
  ] as const)('attributes an identity-checked seed %s to %s', (seedKey, origin) => {
    const id = propertyDefinitionBlockId(WS, seedKey)
    const row = definitionRow({
      [propertyNameProp.name]: 'seeded:field',
      [seedKeyProp.name]: seedKey,
      [propertyChangeScopeProp.name]: ChangeScope.Automation,
      [propertyHiddenProp.name]: true,
    }, {id})

    expect(parsePropertyDefinitionMetadata(row)).toEqual({
      fieldId: id,
      workspaceId: WS,
      createdAt: 42,
      name: 'seeded:field',
      changeScope: ChangeScope.Automation,
      hidden: true,
      origin,
      seedKey,
    })
  })

  it.each([
    ['system:kernel-data/property/title', 'wrong deterministic id'],
    ['not-a-property-seed', 'invalid seed key'],
  ])('demotes %s with %s to user origin', (seedKey) => {
    const row = definitionRow({
      [propertyNameProp.name]: 'copied:field',
      [seedKeyProp.name]: seedKey,
    })

    expect(parsePropertyDefinitionMetadata(row)).toMatchObject({
      fieldId: row.id,
      origin: 'user',
    })
    expect(parsePropertyDefinitionMetadata(row)).not.toHaveProperty('seedKey')
  })

  it('rejects malformed present metadata fields instead of silently defaulting them', () => {
    for (const scope of ['', 'not-a-scope']) {
      expect(parsePropertyDefinitionMetadata(definitionRow({
        [propertyNameProp.name]: 'bad:scope',
        [propertyChangeScopeProp.name]: scope,
      }))).toBeNull()
    }
    expect(parsePropertyDefinitionMetadata(definitionRow({
      [propertyNameProp.name]: 'bad:hidden',
      [propertyHiddenProp.name]: 'yes',
    }))).toBeNull()
  })

  it('ignores deleted, non-schema, and nameless rows', () => {
    expect(parsePropertyDefinitionMetadata(definitionRow({
      [propertyNameProp.name]: 'deleted',
    }, {deleted: true}))).toBeNull()
    expect(parsePropertyDefinitionMetadata({
      ...definitionRow({[propertyNameProp.name]: 'not-schema'}),
      properties: {[propertyNameProp.name]: 'not-schema'},
    })).toBeNull()
    expect(parsePropertyDefinitionMetadata(definitionRow({
      [propertyNameProp.name]: '',
    }))).toBeNull()
  })
})
