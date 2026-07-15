import {describe, expect, it} from 'vitest'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {definitionSeedsFacet, propertyEditorOverridesFacet} from './facets'
import {kernelDataExtension} from './kernelDataExtension'
import {isPropertySeedDeclaration} from './propertySeeds'
import {
  KERNEL_PROPERTY_SEEDS,
  aliasesProp,
  propertyChangeScopeProp,
  propertyDefaultProp,
  typesProp,
} from './properties'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {ChangeScope} from './api/changeScope'

const hiddenKernelPropertyNames = new Set([
  'createdAt',
  'editorFocusRequest',
  'editorSelection',
  'focusedBlockLocation',
  'system:collapsed',
  'isEditing',
  'property-schema:config',
  'rendererName',
  'renderer',
  'blockSelectionState',
  'system:showProperties',
  'sourceBlockId',
  'topLevelBlockId',
])

const uiStatePropertyNames = new Set([
  'system:showProperties', 'isEditing', 'topLevelBlockId',
  'focusedBlockLocation', 'activePanelId', 'scrollTop', 'panelViewMode',
  'editorSelection', 'editorFocusRequest', 'blockSelectionState',
])

describe('kernel property seed conversion', () => {
  it('defines all 33 kernel properties as valid, unique seeds', () => {
    const seeds = KERNEL_PROPERTY_SEEDS

    expect(seeds).toHaveLength(33)
    expect(new Set(seeds.map(seed => seed.seedKey))).toHaveLength(seeds.length)
    expect(new Set(seeds.map(seed => seed.name))).toHaveLength(seeds.length)
    expect(seeds.every(isPropertySeedDeclaration)).toBe(true)

    expect(new Set(seeds.filter(seed => seed.changeScope === ChangeScope.UiState).map(seed => seed.name)))
      .toEqual(uiStatePropertyNames)
    expect(seeds.filter(seed => !uiStatePropertyNames.has(seed.name))
      .every(seed => seed.changeScope === ChangeScope.BlockDefault)).toBe(true)
  })

  it('moves the prior hidden-only override list onto seed metadata', () => {
    const dataRuntime = resolveFacetRuntimeSync([kernelDataExtension])
    const uiRuntime = resolveFacetRuntimeSync([kernelPropertyUiExtension])
    const seeds = dataRuntime.read(definitionSeedsFacet)

    expect(new Set(seeds.filter(seed => seed.hidden).map(seed => seed.name)))
      .toEqual(hiddenKernelPropertyNames)
    // The override facet is keyed by seed identity (B′ §8), not name.
    expect([...uiRuntime.read(propertyEditorOverridesFacet).keys()]).toEqual([typesProp.seedKey])
  })

  it('persists only defaults that differ from their preset core', () => {
    const seeds = resolveFacetRuntimeSync([kernelDataExtension]).read(definitionSeedsFacet)
    expect(seeds.filter(seed => seed.hasExplicitDefault).map(seed => seed.name).sort()).toEqual([
      'blockSelectionState',
      'property-schema:change-scope',
      'property-schema:config',
    ])
    expect(seeds.find(seed => seed.name === 'blockSelectionState')?.encodedDefaultValue)
      .toEqual({selectedBlockIds: [], anchorBlockId: null})
    expect(seeds.find(seed => seed.name === 'property-schema:config')?.encodedDefaultValue)
      .toEqual({})
  })

  it('does not share collection default instances between handles', () => {
    expect(typesProp.defaultValue).toEqual([])
    expect(aliasesProp.defaultValue).toEqual([])
    expect(typesProp.defaultValue).not.toBe(aliasesProp.defaultValue)
  })

  it('preserves meaningful preset config', () => {
    const seeds = resolveFacetRuntimeSync([kernelDataExtension]).read(definitionSeedsFacet)
    expect(seeds.find(seed => seed.name === 'block-type:properties')?.encodedConfig)
      .toEqual({targetTypes: ['property-schema']})
    expect(propertyChangeScopeProp.presetId).toBe('strict-enum')
    expect(propertyChangeScopeProp.defaultValue).toBe(ChangeScope.BlockDefault)
    expect(() => propertyChangeScopeProp.codec.encode('' as ChangeScope)).toThrow()
  })

  it('preserves raw property-default null-versus-absence semantics', () => {
    expect(propertyDefaultProp.presetId).toBe('raw-json')
    expect(propertyDefaultProp.hasExplicitDefault).toBe(false)
    expect(propertyDefaultProp.defaultValue).toBeUndefined()
    expect(propertyDefaultProp.codec.decode(undefined)).toBeUndefined()
    expect(propertyDefaultProp.codec.decode(null)).toBeNull()
    expect(propertyDefaultProp.codec.encode(undefined)).toBeUndefined()
    expect(propertyDefaultProp.codec.encode(null)).toBeNull()
  })
})
