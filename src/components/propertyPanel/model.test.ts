// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  definePropertyEditorOverride,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import { typesProp } from '@/data/properties'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import {seedProperty} from '@/data/propertySeeds'
import { buildPropertyPanelModel } from './model'

const schemasMap = (schemas: readonly AnyPropertySchema[]) =>
  new Map(schemas.map(schema => [schema.name, schema]))

const uisMap = (uis: readonly AnyPropertyEditorOverride[]) =>
  new Map(uis.map(ui => [ui.name, ui]))

describe('buildPropertyPanelModel', () => {
  it('pins type membership outside loose property sections', () => {
    const visibleProp = defineProperty<string>('visible', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {
        [visibleProp.name]: 'shown',
        [typesProp.name]: typesProp.codec.encode(['task']),
      },
      schemas: schemasMap([visibleProp, typesProp]),
      propertyDefinitions: null,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    expect(model.pinnedRows.map(row => row.name)).toEqual([typesProp.name])
    expect(model.sections.flatMap(section => section.rows.map(row => row.name))).toEqual([
      visibleProp.name,
    ])
  })

  it('uses property UI hidden metadata to move fields into capability-limited hidden rows', () => {
    const visibleProp = defineProperty<string>('visible', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const internalProp = defineProperty<string>('plugin:internal', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {
        [visibleProp.name]: 'shown',
        [internalProp.name]: 'secret',
      },
      schemas: schemasMap([visibleProp, internalProp]),
      propertyDefinitions: null,
      uis: uisMap([
        definePropertyEditorOverride<string>({
          name: internalProp.name,
          label: 'Internal',
          hidden: true,
        }),
      ]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    const visibleNames = model.sections.flatMap(section => section.rows.map(row => row.name))
    expect(visibleNames).toContain(visibleProp.name)
    expect(visibleNames).not.toContain(internalProp.name)
    expect(model.hiddenSection.rows.map(row => ({
      name: row.name,
      labelText: row.labelText,
      canRename: row.canRename,
      canDelete: row.canDelete,
      canChangeShape: row.canChangeShape,
      isHidden: row.isHidden,
    }))).toEqual([{
      name: internalProp.name,
      labelText: 'Internal',
      canRename: false,
      canDelete: false,
      canChangeShape: false,
      isHidden: true,
    }])
  })

  it('renders synthetic known rows as unset values without storing defaults', () => {
    const dateProp = defineProperty<Date | undefined>('due', {
      codec: codecs.date,
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {},
      schemas: schemasMap([dateProp]),
      propertyDefinitions: null,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
      syntheticRows: [{
        name: dateProp.name,
        encodedValue: undefined,
        isSet: false,
      }],
    })

    const row = model.sections.flatMap(section => section.rows)
      .find(candidate => candidate.name === dateProp.name)
    expect(row).toMatchObject({
      name: dateProp.name,
      isSet: false,
      decodeFailed: false,
      value: undefined,
    })
  })

  it('falls back to scope and system-name hiding without UI metadata', () => {
    const uiStateProp = defineProperty<string>('plugin:selection', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.UiState,
    })
    const systemProp = defineProperty<boolean>('system:plugin-flag', {
      codec: codecs.boolean,
      defaultValue: false,
      changeScope: ChangeScope.BlockDefault,
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {
        [uiStateProp.name]: 'cursor',
        [systemProp.name]: true,
      },
      schemas: schemasMap([uiStateProp, systemProp]),
      propertyDefinitions: null,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    const visibleNames = model.sections.flatMap(section => section.rows.map(row => row.name))
    expect(visibleNames).not.toContain(uiStateProp.name)
    expect(visibleNames).not.toContain(systemProp.name)
    expect(model.hiddenSection.rows.map(row => row.name)).toEqual([
      uiStateProp.name,
      systemProp.name,
    ])
  })

  it('uses projected hidden metadata that is absent from the ambient schema', () => {
    const schema = defineProperty<string>('secret', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const hidden: PropertyDefinitionMetadata = {
      fieldId: 'field-secret',
      workspaceId: 'ws',
      createdAt: 1,
      name: schema.name,
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
      origin: 'user',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map([[schema.name, schema]]),
      projectedDefinitions: new Map([[hidden.fieldId, {metadata: hidden}]]),
      seeds: [],
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {[schema.name]: 'private'},
      schemas: new Map([...propertyDefinitions.schemas, [typesProp.name, typesProp]]),
      propertyDefinitions,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    expect(model.sections.flatMap(section => section.rows.map(row => row.name)))
      .not.toContain(schema.name)
    expect(model.hiddenSection.rows.map(row => row.name)).toEqual([schema.name])
  })

  it('does not resurface a hidden declaration through an unset type-contributed row', () => {
    const hidden = seedProperty({
      seedKey: 'plugin:test/property/secret',
      revision: 1,
      name: 'secret',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
    })
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map(),
      seeds: [hidden],
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {[typesProp.name]: typesProp.codec.encode(['test'])},
      schemas: new Map([...propertyDefinitions.schemas, [typesProp.name, typesProp]]),
      propertyDefinitions,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map([['test', {id: 'test', properties: [hidden]}]]),
    })

    expect(model.sections.flatMap(section => section.rows.map(row => row.name)))
      .not.toContain(hidden.name)
  })

  it('renders a selected metadata-only plugin definition as an attributed read-only row', () => {
    const metadataOnly: PropertyDefinitionMetadata = {
      fieldId: 'field-srs-config',
      workspaceId: 'ws',
      createdAt: 1,
      name: 'srs:config',
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: 'plugin:srs-rescheduling',
      seedKey: 'srs-rescheduling/property/config',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map([[
        metadataOnly.fieldId,
        {metadata: metadataOnly},
      ]]),
      seeds: [],
    })
    const encodedValue = {queue: ['block-1'], threshold: 2}

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {[metadataOnly.name]: encodedValue},
      schemas: new Map([...propertyDefinitions.schemas, [typesProp.name, typesProp]]),
      propertyDefinitions,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    const row = model.sections.flatMap(section => section.rows)
      .find(candidate => candidate.name === metadataOnly.name)
    expect(row).toMatchObject({
      name: metadataOnly.name,
      encodedValue,
      value: encodedValue,
      schemaUnknown: false,
      readOnly: true,
      statusText: 'Provided by srs-rescheduling — not installed/disabled',
      canRename: false,
      canDelete: false,
      canChangeShape: false,
      isHidden: false,
    })
    expect(row?.Editor).toBeUndefined()
  })

  it('attributes metadata-only user definitions to the workspace user', () => {
    const metadataOnly: PropertyDefinitionMetadata = {
      fieldId: 'field-user-config',
      workspaceId: 'ws',
      createdAt: 1,
      name: 'user:config',
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: 'user',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map([[
        metadataOnly.fieldId,
        {metadata: metadataOnly},
      ]]),
      seeds: [],
    })

    const model = buildPropertyPanelModel({
      blockId: 'block-1',
      updatedAt: 1700_000_000_000,
      updatedBy: 'user-1',
      properties: {[metadataOnly.name]: {enabled: true}},
      schemas: new Map([...propertyDefinitions.schemas, [typesProp.name, typesProp]]),
      propertyDefinitions,
      uis: uisMap([]),
      presets: new Map(),
      typesRegistry: new Map(),
    })

    expect(model.sections.flatMap(section => section.rows)
      .find(row => row.name === metadataOnly.name)?.statusText)
      .toBe('User-created definition — behavior unavailable')
  })

})
