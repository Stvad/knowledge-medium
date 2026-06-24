/** ValuePreset — the user-facing value vocabulary that maps onto codecs.
 *  See user-defined-properties.md §1 for the full design. */

import type { ComponentType } from 'react'
import type { Codec } from './codecs'
import type { PropertyEditor } from './propertySchema'

export interface ValuePresetConfigEditorProps<TConfig> {
  value: TConfig
  onChange: (next: TConfig) => void
}

export interface ValuePreset<TValue = unknown, TConfig = void> {
  /** Stable id; matches the codec's `type` for codecs built by this
   *  preset. Persisted on user-defined schema blocks. */
  readonly id: string
  /** Human label for the picker. */
  readonly label: string
  /** Build the codec from preset-specific config. Called at schema
   *  registration time and on runtime rebuild — must be deterministic
   *  in `config` and only run on validated config (see configCodec). */
  readonly build: (config: TConfig) => Codec<TValue>
  /** Default value used when the schema is registered and the property
   *  is first materialised. Lives on the resulting `PropertySchema`. */
  readonly defaultValue: TValue
  /** Default config used when the preset is registered through the
   *  AddPropertyForm or the optimistic-materialize path without
   *  user-supplied config. Required when `TConfig` is non-void; void
   *  presets omit it. */
  readonly defaultConfig?: TConfig
  /** Validates and parses raw JSON read from `presetConfigProp` into
   *  `TConfig`. Required when `TConfig` is non-void. Throws on
   *  malformed input — `UserSchemasService` catches, logs, and skips
   *  schemas with invalid config rather than passing untyped JSON to
   *  `build`. */
  readonly configCodec?: Codec<TConfig>
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

/** Variance-erased preset type for storage in heterogeneous
 *  collections (`valuePresetsFacet`'s contributions, etc.). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePreset = ValuePreset<any, any>

/** Helper for plugin authors to define a preset with full type
 *  inference on the value/config slots. */
export const definePreset = <TValue = unknown, TConfig = void>(
  preset: ValuePreset<TValue, TConfig>,
): ValuePreset<TValue, TConfig> => preset
