/** ValuePreset — the user-facing value vocabulary that maps onto codecs.
 *  See user-defined-properties.md §1 for the full design. */

import type { ComponentType } from 'react'
import type { PropertyEditor } from './propertySchema'
import type { ValuePresetCore } from './valuePresetCore'

export interface ValuePresetConfigEditorProps<TConfig> {
  value: TConfig
  onChange: (next: TConfig) => void
}

export interface ValuePresetPresentation<TValue = unknown, TConfig = void> {
  /** Stable join key; must match the corresponding codec core id. */
  readonly id: string
  /** Human label for the picker. */
  readonly label: string
  /** Editor used for any property whose codec's `type` matches this
   *  preset's `id`. Required — every preset ships its own editor.
   *  Exact-name `PropertyEditorOverride.Editor` contributions still
   *  win first. */
  readonly Editor: PropertyEditor<TValue>
  /** Optional glyph for the property-row button, config sheet, and
   *  picker. Plugins without designed icons can omit; falls back to a
   *  generic icon. */
  readonly Glyph?: ComponentType<{className?: string}>
  /** Optional config UI rendered inside the property-schema block
   *  renderer (the side panel users open by clicking the property
   *  glyph). Only meaningful when `TConfig` is non-void. */
  readonly ConfigEditor?: ComponentType<ValuePresetConfigEditorProps<TConfig>>
  /** When true, this preset supplies an editor/glyph for its codec type
   *  but is NOT offered as a user-creatable property type in the
   *  AddPropertyForm picker. Used by presets whose config can't be set
   *  through the generic picker (e.g. `enum`, whose options must come
   *  from a plugin's settings schema), so the editor still resolves for
   *  stored values without surfacing a useless "create" entry. */
  readonly hideFromPicker?: boolean
}

export interface ValuePreset<TValue = unknown, TConfig = void>
  extends ValuePresetCore<TValue, TConfig>, ValuePresetPresentation<TValue, TConfig> {}

/** Variance-erased preset type for storage in heterogeneous
 *  collections (`valuePresetsFacet`'s contributions, etc.). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePreset = ValuePreset<any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePresetPresentation = ValuePresetPresentation<any, any>

export const joinValuePreset = <TValue, TConfig>(
  core: ValuePresetCore<TValue, TConfig>,
  presentation: ValuePresetPresentation<NoInfer<TValue>, NoInfer<TConfig>>,
): ValuePreset<TValue, TConfig> => {
  if (core.id !== presentation.id) {
    throw new Error(`ValuePreset id mismatch: core ${JSON.stringify(core.id)} vs presentation ${JSON.stringify(presentation.id)}`)
  }
  return {...presentation, ...core}
}

export interface SplitValuePreset<TValue, TConfig> {
  readonly core: ValuePresetCore<TValue, TConfig>
  readonly presentation: ValuePresetPresentation<TValue, TConfig>
  readonly preset: ValuePreset<TValue, TConfig>
}

/** Typed authoring path for the split facets. Core inference owns TValue and
 * TConfig; `NoInfer` prevents an incompatible presentation from widening them
 * into a union after the two contributions are stored in erased registries. */
export const defineSplitPreset = <TValue, TConfig = void>(
  core: ValuePresetCore<TValue, TConfig>,
  presentation: ValuePresetPresentation<NoInfer<TValue>, NoInfer<TConfig>>,
): SplitValuePreset<TValue, TConfig> => ({
  core,
  presentation,
  preset: joinValuePreset(core, presentation),
})

/** Helper for plugin authors to define a preset with full type
 *  inference on the value/config slots. */
export const definePreset = <TValue = unknown, TConfig = void>(
  preset: ValuePreset<TValue, TConfig>,
): ValuePreset<TValue, TConfig> => preset
