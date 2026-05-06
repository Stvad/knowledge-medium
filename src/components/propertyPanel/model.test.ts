// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  definePropertyUi,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
} from '@/data/api'
import { buildPropertyPanelModel } from './model'

const schemasMap = (schemas: readonly AnyPropertySchema[]) =>
  new Map(schemas.map(schema => [schema.name, schema]))

const uisMap = (uis: readonly AnyPropertyUiContribution[]) =>
  new Map(uis.map(ui => [ui.name, ui]))

describe('buildPropertyPanelModel', () => {
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
      uis: uisMap([
        definePropertyUi<string>({
          name: internalProp.name,
          label: 'Internal',
          hidden: true,
        }),
      ]),
      editorFallbacks: [],
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
      uis: uisMap([]),
      editorFallbacks: [],
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
})
