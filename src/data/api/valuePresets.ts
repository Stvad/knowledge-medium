/** ValuePreset — the user-facing value vocabulary that maps onto codecs.
 *  See user-defined-properties.md §1 for the full design. */

import type { ComponentType } from 'react'
import type { PropertyEditor } from './propertySchema'
import type { ValuePresetCore } from './valuePresetCore'

export interface ValuePresetConfigEditorProps<TConfig> {
  value: TConfig
  onChange: (next: TConfig) => void
}

interface ValuePresetPresentationBase<TConfig = void> {
  /** Stable join key; must match the corresponding codec core id. */
  readonly id: string
  /** Human label for the picker. */
  readonly label: string
  /** Optional glyph for the property-row button, config sheet, and
   *  picker. Plugins without designed icons can omit; falls back to a
   *  generic icon. */
  readonly Glyph?: ComponentType<{className?: string}>
  /** Optional config UI rendered inside the property-schema block
   *  renderer (the side panel users open by clicking the property
   *  glyph). Only meaningful when `TConfig` is non-void. */
  readonly ConfigEditor?: ComponentType<ValuePresetConfigEditorProps<TConfig>>
}

/** A picker-visible presentation must provide an editor. Hidden codec-only
 *  presets may omit it when their values have no generic editing UI. */
export type ValuePresetPresentation<TValue = unknown, TConfig = void> =
  ValuePresetPresentationBase<TConfig> & (
    | {readonly Editor: PropertyEditor<TValue>; readonly hideFromPicker?: boolean}
    | {readonly Editor?: never; readonly hideFromPicker: true}
  )

/** Legacy full-preset authoring contract. Kept as an interface so existing
 *  plugin declarations remain extendable and editorful presets may compute
 *  `hideFromPicker` dynamically. */
export interface ValuePreset<TValue = unknown, TConfig = void>
  extends ValuePresetCore<TValue, TConfig>, ValuePresetPresentationBase<TConfig> {
  readonly Editor: PropertyEditor<TValue>
  readonly hideFromPicker?: boolean
}

export type JoinedValuePreset<TValue = unknown, TConfig = void> =
  ValuePresetCore<TValue, TConfig> & ValuePresetPresentation<TValue, TConfig>

/** Variance-erased preset type for storage in heterogeneous
 *  legacy `valuePresetsFacet` contributions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePreset = ValuePreset<any, any>

/** Variance-erased canonical preset assembled from either split or legacy
 * contributions. Hidden codec-only entries may intentionally lack an editor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJoinedValuePreset = JoinedValuePreset<any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePresetPresentation = ValuePresetPresentation<any, any>

export const joinValuePreset = <TValue, TConfig>(
  core: ValuePresetCore<TValue, TConfig>,
  presentation: ValuePresetPresentation<NoInfer<TValue>, NoInfer<TConfig>>,
): JoinedValuePreset<TValue, TConfig> => {
  if (core.id !== presentation.id) {
    throw new Error(`ValuePreset id mismatch: core ${JSON.stringify(core.id)} vs presentation ${JSON.stringify(presentation.id)}`)
  }
  return {...presentation, ...core}
}

export interface SplitValuePreset<TValue, TConfig> {
  readonly core: ValuePresetCore<TValue, TConfig>
  readonly presentation: ValuePresetPresentation<TValue, TConfig>
  readonly preset: JoinedValuePreset<TValue, TConfig>
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
