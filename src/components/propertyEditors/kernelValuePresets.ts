/** Kernel ValuePreset set + the contributions extension that registers
 *  them via `valuePresetsFacet`. See user-defined-properties.md §1. */

import {
  AtSign,
  Calendar,
  CheckSquare,
  Hash,
  Link as LinkIcon,
  List,
  Type as TypeIcon,
} from 'lucide-react'
import {
  CodecError,
  codecs,
  definePreset,
  type AnyValuePreset,
  type Codec,
  type PropertyEditor,
  type RefCodecOptions,
} from '@/data/api'
import { valuePresetsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
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

/** Validates ref / refList preset config. `targetTypes`, when present,
 *  must be a string[]; anything else is rejected at the parse boundary
 *  so `build` always sees well-typed config. */
const refConfigCodec: Codec<RefCodecOptions> = {
  type: 'ref-config',
  encode: cfg => {
    if (cfg.targetTypes === undefined || cfg.targetTypes.length === 0) return {}
    return {targetTypes: [...cfg.targetTypes]}
  },
  decode: json => {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new CodecError('ref config object', json)
    }
    const obj = json as Record<string, unknown>
    if (obj.targetTypes !== undefined) {
      if (!Array.isArray(obj.targetTypes) || !obj.targetTypes.every(t => typeof t === 'string')) {
        throw new CodecError('ref config targetTypes (string[])', obj.targetTypes)
      }
    }
    return {targetTypes: obj.targetTypes as readonly string[] | undefined}
  },
}

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

export const kernelValuePresets: readonly AnyValuePreset[] = [
  definePreset<string>({
    id: 'string',
    label: 'Plain text',
    Glyph: TypeIcon,
    build: () => codecs.string,
    defaultValue: '',
    Editor: asEditor<string>(StringPropertyEditor),
  }),
  definePreset<number>({
    id: 'number',
    label: 'Number',
    Glyph: Hash,
    build: () => codecs.number,
    defaultValue: 0,
    Editor: asEditor<number>(NumberPropertyEditor),
  }),
  definePreset<boolean>({
    id: 'boolean',
    label: 'Checkbox',
    Glyph: CheckSquare,
    build: () => codecs.boolean,
    defaultValue: false,
    Editor: asEditor<boolean>(BooleanPropertyEditor),
  }),
  definePreset<unknown[]>({
    id: 'list',
    label: 'Options',
    Glyph: List,
    build: () => codecs.list(codecs.unsafeIdentity<unknown>()),
    defaultValue: [],
    Editor: asEditor<unknown[]>(ListPropertyEditor),
  }),
  definePreset<Date | undefined>({
    id: 'date',
    label: 'Date',
    Glyph: Calendar,
    // codecs.date is natively absence-aware (Codec<Date | undefined>) —
    // see codecs.ts for why no codecs.optional wrapper exists.
    build: () => codecs.date,
    defaultValue: undefined,
    Editor: asEditor<Date | undefined>(DatePropertyEditor),
  }),
  definePreset<string>({
    id: 'url',
    label: 'URL',
    Glyph: LinkIcon,
    build: () => codecs.url,
    defaultValue: '',
    Editor: asEditor<string>(UrlPropertyEditor),
  }),
  definePreset<string, RefCodecOptions>({
    id: 'ref',
    label: 'Reference',
    Glyph: AtSign,
    build: cfg => codecs.ref(cfg),
    defaultValue: '',
    defaultConfig: {},
    configCodec: refConfigCodec,
    Editor: asEditor<string>(RefPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
  definePreset<readonly string[], RefCodecOptions>({
    id: 'refList',
    label: 'References',
    Glyph: AtSign,
    build: cfg => codecs.refList(cfg),
    defaultValue: [],
    defaultConfig: {},
    configCodec: refConfigCodec,
    Editor: asEditor<readonly string[]>(RefListPropertyEditor),
    ConfigEditor: RefTargetTypePicker,
  }),
]

export const kernelValuePresetsExtension: AppExtension = systemToggle({
  id: 'system:kernel-value-presets',
  name: 'Property value presets',
  description: "Default editor + glyph for each codec type, used by any property that doesn't ship a per-name override.",
  essential: true,
}).of(kernelValuePresets.map(preset => valuePresetsFacet.of(preset, {source: 'kernel-ui'})))
