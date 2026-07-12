/** React presentation joined onto data-layer kernel preset cores. */

import {
  AtSign,
  Calendar,
  CheckSquare,
  ChevronDownSquare,
  Hash,
  Link as LinkIcon,
  List,
  Type as TypeIcon,
} from 'lucide-react'
import {
  defineSplitPreset,
  type AnyValuePreset,
  type AnyValuePresetPresentation,
  type PropertyEditor,
  type ValuePresetCore,
  type ValuePresetPresentation,
} from '@/data/api'
import { valuePresetPresentationsFacet, valuePresetsFacet } from '@/data/facets.js'
import {
  booleanValuePresetCore,
  dateValuePresetCore,
  enumValuePresetCore,
  listValuePresetCore,
  jsonValuePresetCore,
  numberValuePresetCore,
  optionalJsonValuePresetCore,
  optionalNumberValuePresetCore,
  optionalRefValuePresetCore,
  optionalStringValuePresetCore,
  refListValuePresetCore,
  refValuePresetCore,
  stringValuePresetCore,
  stringListValuePresetCore,
  urlValuePresetCore,
} from '@/data/kernelValuePresetCores'
import {markValuePresetCompatibilityMirror} from '@/data/valuePresetRegistry'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import {
  BooleanPropertyEditor,
  DatePropertyEditor,
  ListPropertyEditor,
  NumberPropertyEditor,
  StringPropertyEditor,
  UrlPropertyEditor,
} from './defaults'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'
import { RefTargetTypePicker } from './RefTargetTypePicker'
import { SelectPropertyEditor } from './SelectPropertyEditor'
import {EnumOptionsConfigEditor} from './EnumOptionsConfigEditor'

/** Existing kernel editors are typed `PropertyEditor<unknown>`, which
 *  is invariant against the per-preset `PropertyEditor<TValue>`
 *  (PropertyEditor's T appears in both `value: T` and
 *  `onChange: (next: T) => void`). The cast at the preset boundary
 *  mirrors `AnyPropertySchema`'s `any`-escape pattern — runtime safety
 *  comes from the codec encoding/decoding T-typed values, not from
 *  static narrowing through the editor signature. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asEditor = <T>(editor: PropertyEditor<any>): PropertyEditor<T> =>
  editor as unknown as PropertyEditor<T>

const kernelPresetPair = <TValue, TConfig>(
  core: ValuePresetCore<TValue, TConfig>,
  presentation: ValuePresetPresentation<NoInfer<TValue>, NoInfer<TConfig>>,
) => {
  const split = defineSplitPreset(core, presentation)
  const compatibility = split.preset.Editor
    ? markValuePresetCompatibilityMirror(split.preset) as AnyValuePreset
    : undefined
  return {
    presentation: split.presentation,
    compatibility,
  }
}

const kernelValuePresetPairs = [
  kernelPresetPair(stringValuePresetCore, {
    id: 'string',
    label: 'Plain text',
    Glyph: TypeIcon,
    Editor: asEditor<string>(StringPropertyEditor),
  }),
  kernelPresetPair(numberValuePresetCore, {
    id: 'number',
    label: 'Number',
    Glyph: Hash,
    Editor: asEditor<number>(NumberPropertyEditor),
  }),
  kernelPresetPair(booleanValuePresetCore, {
    id: 'boolean',
    label: 'Checkbox',
    Glyph: CheckSquare,
    Editor: asEditor<boolean>(BooleanPropertyEditor),
  }),
  kernelPresetPair(listValuePresetCore, {
    id: 'list',
    label: 'Options',
    Glyph: List,
    Editor: asEditor<unknown[]>(ListPropertyEditor),
  }),
  kernelPresetPair(dateValuePresetCore, {
    id: 'date',
    label: 'Date',
    Glyph: Calendar,
    Editor: asEditor<Date | undefined>(DatePropertyEditor),
  }),
  kernelPresetPair(urlValuePresetCore, {
    id: 'url',
    label: 'URL',
    Glyph: LinkIcon,
    Editor: asEditor<string>(UrlPropertyEditor),
  }),
  kernelPresetPair(enumValuePresetCore, {
    // Options ride on the codec and are edited on the schema definition.
    id: 'enum',
    label: 'Choice',
    Glyph: ChevronDownSquare,
    Editor: asEditor<string>(SelectPropertyEditor),
    ConfigEditor: EnumOptionsConfigEditor,
  }),
  kernelPresetPair(refValuePresetCore, {
    id: 'ref',
    label: 'Reference',
    Glyph: AtSign,
    Editor: asEditor<string>(RefPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
  kernelPresetPair(refListValuePresetCore, {
    id: 'refList',
    label: 'References',
    Glyph: AtSign,
    Editor: asEditor<readonly string[]>(RefListPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
  kernelPresetPair(optionalStringValuePresetCore, {
    id: 'optional-string',
    label: 'Optional text',
    Glyph: TypeIcon,
    Editor: asEditor<string | undefined>(StringPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPair(optionalNumberValuePresetCore, {
    id: 'optional-number',
    label: 'Optional number',
    Glyph: Hash,
    Editor: asEditor<number | undefined>(NumberPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPair(stringListValuePresetCore, {
    id: 'string-list',
    label: 'Text list',
    Glyph: List,
    Editor: asEditor<readonly string[]>(ListPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPair(optionalRefValuePresetCore, {
    id: 'optional-ref',
    label: 'Optional reference',
    Glyph: AtSign,
    Editor: asEditor<string | undefined>(RefPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
    hideFromPicker: true,
  }),
  kernelPresetPair(jsonValuePresetCore, {
    id: 'json',
    label: 'JSON',
    hideFromPicker: true,
  }),
  kernelPresetPair(optionalJsonValuePresetCore, {
    id: 'optional-json',
    label: 'Optional JSON',
    hideFromPicker: true,
  }),
]

export const kernelValuePresetPresentations: readonly AnyValuePresetPresentation[] =
  kernelValuePresetPairs.map(pair => pair.presentation)

/** Compatibility mirror for direct readers of the pre-split full facet.
 * Canonical UI/data consumers use the live core + presentation join. */
export const kernelValuePresets: readonly AnyValuePreset[] =
  kernelValuePresetPairs.flatMap(pair => pair.compatibility ? [pair.compatibility] : [])

export const kernelValuePresetsExtension: AppExtension = systemToggle({
  id: 'system:kernel-value-presets',
  name: 'Property value presets',
  description: "Default editor + glyph for each codec type, used by any property that doesn't ship a per-name override.",
  essential: true,
}).of([
  kernelValuePresetPresentations.map(preset => valuePresetPresentationsFacet.of(preset, {source: 'kernel-ui'})),
  kernelValuePresets.map(preset => valuePresetsFacet.of(preset, {source: 'kernel-ui-compat'})),
])
