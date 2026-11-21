// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import type {AnyCodec, AnyValuePresetCore} from '@/data/api'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {
  valuePresetCoresFacet,
  valuePresetPresentationsFacet,
} from '@/data/facets'
import {extensionsDataExtension} from './extensions-settings/dataExtension'
import {extensionsSettingsPlugin} from './extensions-settings'
import {
  extensionsOverridesPresetCore,
  overridesCodec,
} from './extensions-settings/config'
import {keybindingsSettingsDataExtension} from './keybindings-settings/dataExtension'
import {keybindingsSettingsPlugin} from './keybindings-settings'
import {
  keybindingOverridesCodec,
  keybindingOverridesPresetCore,
} from './keybindings-settings/config'
import {backlinksDataExtension} from './backlinks/dataExtension'
import {backlinksPlugin} from './backlinks'
import {
  backlinksFilterCodec,
  backlinksFilterPresetCore,
  backlinksFilterProp,
} from './backlinks/filterProperty'
import {dailyNoteBacklinksDefaultsProp} from './backlinks/dailyNoteDefaults'
import {blockTaggingDataExtension} from './block-tagging/dataExtension'
import {blockTaggingPlugin} from './block-tagging'
import {
  blockTagsConfigCodec,
  blockTagsConfigPresetCore,
} from './block-tagging/config'
import {groupedBacklinksDataExtension} from './grouped-backlinks/dataExtension'
import {groupedBacklinksPlugin} from './grouped-backlinks'
import {
  groupedBacklinksConfigCodec,
  groupedBacklinksConfigPresetCore,
  groupedBacklinksOverridesCodec,
  groupedBacklinksOverridesPresetCore,
} from './grouped-backlinks/config'

const DATA_EXTENSIONS = [
  extensionsDataExtension,
  keybindingsSettingsDataExtension,
  backlinksDataExtension,
  blockTaggingDataExtension,
  groupedBacklinksDataExtension,
]

const FULL_PLUGINS = [
  extensionsSettingsPlugin,
  keybindingsSettingsPlugin,
  backlinksPlugin,
  blockTaggingPlugin,
  groupedBacklinksPlugin,
]

const EXPECTED: readonly (readonly [AnyValuePresetCore, AnyCodec])[] = [
  [extensionsOverridesPresetCore, overridesCodec],
  [keybindingOverridesPresetCore, keybindingOverridesCodec],
  [backlinksFilterPresetCore, backlinksFilterCodec],
  [blockTagsConfigPresetCore, blockTagsConfigCodec],
  [groupedBacklinksConfigPresetCore, groupedBacklinksConfigCodec],
  [groupedBacklinksOverridesPresetCore, groupedBacklinksOverridesCodec],
]

const EXPECTED_IDS = EXPECTED.map(([core]) => core.id).toSorted()

describe('plugin value preset registrations', () => {
  it('keeps the six custom codec cores in data extensions only', () => {
    const runtime = resolveFacetRuntimeSync(DATA_EXTENSIONS)
    const cores = runtime.read(valuePresetCoresFacet)

    expect([...cores.keys()].toSorted()).toEqual(EXPECTED_IDS)
    expect(runtime.read(valuePresetPresentationsFacet).size).toBe(0)

    for (const [expectedCore, codec] of EXPECTED) {
      const core = cores.get(expectedCore.id)!
      expect(core).toBe(expectedCore)
      expect(core.build(undefined)).toBe(codec)
      expect(core.build(undefined).type).toBe(core.id)

      const encodedDefault = codec.encode(core.defaultValue)
      expect(codec.encode(codec.decode(encodedDefault))).toEqual(encodedDefault)
    }

    expect(backlinksFilterProp.codec).toBe(backlinksFilterCodec)
    expect(dailyNoteBacklinksDefaultsProp.codec).toBe(backlinksFilterCodec)
  })

  it('adds hidden editorless presentations only with the full plugins', () => {
    const runtime = resolveFacetRuntimeSync(FULL_PLUGINS)
    const presentations = runtime.read(valuePresetPresentationsFacet)

    expect([...presentations.keys()].toSorted()).toEqual(EXPECTED_IDS)
    for (const presentation of presentations.values()) {
      expect(presentation.hideFromPicker).toBe(true)
      expect(presentation.Editor).toBeUndefined()
    }
  })
})
