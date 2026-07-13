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
  type AnyValuePresetPresentation,
  type PropertyEditor,
  type ValuePresetCore,
  type ValuePresetPresentation,
} from '@/data/api'
import { valuePresetPresentationsFacet } from '@/data/facets.js'
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

/** Join a kernel core to its presentation, validating the id match, and
 *  return just the presentation half — cores are registered separately via
 *  `kernelDataExtension`. */
const kernelPresetPresentation = <TValue, TConfig>(
  core: ValuePresetCore<TValue, TConfig>,
  presentation: ValuePresetPresentation<NoInfer<TValue>, NoInfer<TConfig>>,
): ValuePresetPresentation<TValue, TConfig> =>
  defineSplitPreset(core, presentation).presentation

export const kernelValuePresetPresentations: readonly AnyValuePresetPresentation[] = [
  kernelPresetPresentation(stringValuePresetCore, {
    id: 'string',
    label: 'Plain text',
    Glyph: TypeIcon,
    Editor: asEditor<string>(StringPropertyEditor),
  }),
  kernelPresetPresentation(numberValuePresetCore, {
    id: 'number',
    label: 'Number',
    Glyph: Hash,
    Editor: asEditor<number>(NumberPropertyEditor),
  }),
  kernelPresetPresentation(booleanValuePresetCore, {
    id: 'boolean',
    label: 'Checkbox',
    Glyph: CheckSquare,
    Editor: asEditor<boolean>(BooleanPropertyEditor),
  }),
  kernelPresetPresentation(listValuePresetCore, {
    id: 'list',
    label: 'Options',
    Glyph: List,
    Editor: asEditor<unknown[]>(ListPropertyEditor),
  }),
  kernelPresetPresentation(dateValuePresetCore, {
    id: 'date',
    label: 'Date',
    Glyph: Calendar,
    Editor: asEditor<Date | undefined>(DatePropertyEditor),
  }),
  kernelPresetPresentation(urlValuePresetCore, {
    id: 'url',
    label: 'URL',
    Glyph: LinkIcon,
    Editor: asEditor<string>(UrlPropertyEditor),
  }),
  kernelPresetPresentation(enumValuePresetCore, {
    // Options ride on the codec and are edited on the schema definition.
    id: 'enum',
    label: 'Choice',
    Glyph: ChevronDownSquare,
    Editor: asEditor<string>(SelectPropertyEditor),
    ConfigEditor: EnumOptionsConfigEditor,
  }),
  kernelPresetPresentation(refValuePresetCore, {
    id: 'ref',
    label: 'Reference',
    Glyph: AtSign,
    Editor: asEditor<string>(RefPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
  kernelPresetPresentation(refListValuePresetCore, {
    id: 'refList',
    label: 'References',
    Glyph: AtSign,
    Editor: asEditor<readonly string[]>(RefListPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
  kernelPresetPresentation(optionalStringValuePresetCore, {
    id: 'optional-string',
    label: 'Optional text',
    Glyph: TypeIcon,
    Editor: asEditor<string | undefined>(StringPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPresentation(optionalNumberValuePresetCore, {
    id: 'optional-number',
    label: 'Optional number',
    Glyph: Hash,
    Editor: asEditor<number | undefined>(NumberPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPresentation(stringListValuePresetCore, {
    id: 'string-list',
    label: 'Text list',
    Glyph: List,
    Editor: asEditor<readonly string[]>(ListPropertyEditor),
    hideFromPicker: true,
  }),
  kernelPresetPresentation(optionalRefValuePresetCore, {
    id: 'optional-ref',
    label: 'Optional reference',
    Glyph: AtSign,
    Editor: asEditor<string | undefined>(RefPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
    hideFromPicker: true,
  }),
  kernelPresetPresentation(jsonValuePresetCore, {
    id: 'json',
    label: 'JSON',
    hideFromPicker: true,
  }),
  kernelPresetPresentation(optionalJsonValuePresetCore, {
    id: 'optional-json',
    label: 'Optional JSON',
    hideFromPicker: true,
  }),
]

export const kernelValuePresetsExtension: AppExtension = systemToggle({
  id: 'system:kernel-value-presets',
  name: 'Property value presets',
  description: "Default editor + glyph for each codec type, used by any property that doesn't ship a per-name override.",
  essential: true,
}).of([
  kernelValuePresetPresentations.map(preset => valuePresetPresentationsFacet.of(preset, {source: 'kernel-ui'})),
])
