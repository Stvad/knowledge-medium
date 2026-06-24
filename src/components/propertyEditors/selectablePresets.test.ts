// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { AnyValuePreset } from '@/data/api'
import { selectablePresets } from './selectablePresets'

const preset = (id: string, label: string, hideFromPicker = false): AnyValuePreset =>
  ({id, label, hideFromPicker}) as unknown as AnyValuePreset

const presetMap = (...ps: AnyValuePreset[]) => new Map(ps.map(p => [p.id, p]))

describe('selectablePresets', () => {
  it('drops hideFromPicker presets and sorts the rest by label', () => {
    const presets = presetMap(
      preset('string', 'Plain'),
      preset('enum', 'Choice', true),
      preset('boolean', 'Checkbox'),
    )
    expect(selectablePresets(presets).map(p => p.id)).toEqual(['boolean', 'string'])
  })

  it('keeps a hidden preset only when it is the current type', () => {
    const presets = presetMap(
      preset('string', 'Plain'),
      preset('enum', 'Choice', true),
    )
    // A schema already on the hidden type still shows it…
    expect(selectablePresets(presets, 'enum').map(p => p.id)).toEqual(['enum', 'string'])
    // …but it isn't offered when a different type is current.
    expect(selectablePresets(presets, 'string').map(p => p.id)).toEqual(['string'])
  })
})
