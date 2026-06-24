/** Shared "which value-presets may a user pick as a property type" rule.
 *
 *  Used by both the add-property picker and the schema type-change
 *  selector. A preset with `hideFromPicker` (e.g. `enum`, whose options
 *  can't be configured through the generic picker) is excluded — except
 *  when it's the type a schema is already on (`keepId`), so that schema
 *  still shows its current type rather than a blank selector. */

import type { AnyValuePreset } from '@/data/api'

export const selectablePresets = (
  presets: ReadonlyMap<string, AnyValuePreset>,
  keepId?: string,
): AnyValuePreset[] =>
  Array.from(presets.values())
    .filter(preset => !preset.hideFromPicker || preset.id === keepId)
    .sort((a, b) => a.label.localeCompare(b.label))
