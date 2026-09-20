import {CodecError, codecs, type Codec, type EnumOption, type RefCodecOptions} from './api/codecs'
import {definePresetCore, type AnyValuePresetCore} from './api/valuePresetCore'

/** Validates ref / refList preset config below the UI layer. */
export const refConfigCodec: Codec<RefCodecOptions> = {
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

export interface EnumPresetConfig {readonly options: readonly EnumOption[]}

export const enumConfigCodec: Codec<EnumPresetConfig> = {
  type: 'enum-config',
  encode: config => ({options: config.options.map(option => ({...option}))}),
  decode: json => {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new CodecError('enum config object', json)
    }
    const options = (json as Record<string, unknown>).options
    if (options === undefined) return {options: []}
    if (!Array.isArray(options)) throw new CodecError('enum config options', options)
    return {options: options.map(option => {
      if (
        option === null || typeof option !== 'object' || Array.isArray(option)
        || typeof (option as Record<string, unknown>).value !== 'string'
        || typeof (option as Record<string, unknown>).label !== 'string'
      ) throw new CodecError('enum option {value,label}', option)
      return {
        value: (option as {value: string}).value,
        label: (option as {label: string}).label,
      }
    })}
  },
}

const enumPresetCodec = (options: readonly EnumOption[]): Codec<string> => {
  const configured = codecs.enum(options)
  return {
    ...configured,
    // Empty string is the preset's unset/default sentinel. It is deliberately
    // not exposed as a configured option in the select editor.
    encode: value => value === '' ? '' : configured.encode(value),
    decode: json => json === '' ? '' : configured.decode(json),
    where: {
      encode: value => value === '' ? '' : configured.where!.encode(value),
    },
  }
}

/** `codecs.list(codecs.string)`, which is member-wise and so opts into the
 *  multi-value child shape: `types`, `alias` and the user-facing Options
 *  property store one value child per member rather than one JSON-text child
 *  per list, and each member is spelled plainly because its MEMBER codec is
 *  `string`. Widened to `readonly` elements for the seed handles that expose
 *  them that way.
 *
 *  ONE instance shared by the `list` and `string-list` preset ids. They are
 *  the same encoding under two names — `string-list` is the code-declared
 *  handle, `list` the one the user picks — and writing it twice is how they
 *  would drift. */
const readonlyStringListCodec: Codec<readonly string[]> = codecs.list(codecs.string)

/** The `list` codec as it was before Options became a list of STRINGS: a list
 *  whose members are arbitrary JSON. Kept for `snapshot-history`, the one
 *  code-declared property that genuinely stores object members. */
const jsonListCodec: Codec<unknown[]> = codecs.list(codecs.unsafeIdentity<unknown>())

export const stringValuePresetCore = definePresetCore<string>({
    id: 'string', build: () => codecs.string, defaultValue: '',
  })
export const numberValuePresetCore = definePresetCore<number>({
    id: 'number', build: () => codecs.number, defaultValue: 0,
  })
export const booleanValuePresetCore = definePresetCore<boolean>({
    id: 'boolean', build: () => codecs.boolean, defaultValue: false,
  })
/** The user-pickable "Options" property: a list of STRINGS, because its
 *  members are what a person types into a row and its editor has never been
 *  able to write anything else. That is what gives its value children a plain,
 *  retypeable spelling — through the member path `alias` and `types` already
 *  use, rather than spelling code of its own.
 *
 *  NARROWED IN PLACE, rather than minted as a new preset id that the existing
 *  definitions would then have to be repointed to: the values already stored
 *  under this id are string arrays, and the one property that stored objects
 *  moved to {@link jsonListValuePresetCore} in the same change. That premise
 *  is a measurement, so the measurement is in #1080 and not here. */
export const listValuePresetCore = definePresetCore<readonly string[]>({
    id: 'list', build: () => readonlyStringListCodec, defaultValue: [],
  })
/** Arbitrary-JSON members, for code-declared properties whose element shape no
 *  primitive codec pins. Not offered in the picker — a user's Options property
 *  is `list`, and a member the editor cannot show as text is not one. */
export const jsonListValuePresetCore = definePresetCore<unknown[]>({
    id: 'json-list', build: () => jsonListCodec, defaultValue: [],
  })
export const dateValuePresetCore = definePresetCore<Date | undefined>({
    id: 'date', build: () => codecs.date, defaultValue: undefined,
  })
export const urlValuePresetCore = definePresetCore<string>({
    id: 'url', build: () => codecs.url, defaultValue: '',
  })
export const enumValuePresetCore = definePresetCore<string, EnumPresetConfig>({
    id: 'enum',
    build: config => enumPresetCodec(config.options),
    defaultValue: '',
    defaultConfig: {options: []},
    configCodec: enumConfigCodec,
})
/** Code-declared fixed unions use strict writes, unlike the user-facing Choice
 * preset's empty "unset" sentinel. Declarations must persist an explicit
 * default because no one default can be valid for every configured option set. */
export const strictEnumValuePresetCore = definePresetCore<string, EnumPresetConfig>({
  id: 'strict-enum',
  build: config => codecs.enum(config.options),
  defaultValue: '',
  defaultConfig: {options: []},
  configCodec: enumConfigCodec,
})
export const refValuePresetCore = definePresetCore<string, RefCodecOptions>({
    id: 'ref',
    build: cfg => codecs.ref(cfg),
    defaultValue: '',
    defaultConfig: {},
    configCodec: refConfigCodec,
  })
export const refListValuePresetCore = definePresetCore<readonly string[], RefCodecOptions>({
    id: 'refList',
    build: cfg => codecs.refList(cfg),
    defaultValue: [],
    defaultConfig: {},
    configCodec: refConfigCodec,
  })
export const optionalStringValuePresetCore = definePresetCore<string | undefined>({
  id: 'optional-string', build: () => codecs.optionalString, defaultValue: undefined,
})
export const optionalNumberValuePresetCore = definePresetCore<number | undefined>({
  id: 'optional-number', build: () => codecs.optionalNumber, defaultValue: undefined,
})
export const stringListValuePresetCore = definePresetCore<readonly string[]>({
  id: 'string-list', build: () => readonlyStringListCodec, defaultValue: [],
})
export const optionalRefValuePresetCore = definePresetCore<string | undefined, RefCodecOptions>({
  id: 'optional-ref',
  build: config => codecs.optionalRef(config),
  defaultValue: undefined,
  defaultConfig: {},
  configCodec: refConfigCodec,
})
export const jsonValuePresetCore = definePresetCore<unknown>({
  id: 'json', build: () => codecs.unsafeIdentity<unknown>(), defaultValue: null,
})
export const optionalJsonValuePresetCore = definePresetCore<unknown | undefined>({
  id: 'optional-json', build: () => codecs.optionalIdentity<unknown>(), defaultValue: undefined,
})
/** Identity codec for a property whose stored value is arbitrary JSON of a
 * shape a typed codec can't pin — a mixed number|string like `agent:cancel`,
 * or the internal `property-schema:default` metadata. Unlike `optional-json`,
 * a stored null is a meaningful encoded value and must not collapse to absence;
 * unlike `json`, an absent field defaults to undefined. */
export const rawJsonValuePresetCore = definePresetCore<unknown | undefined>({
  id: 'raw-json', build: () => codecs.unsafeIdentity<unknown | undefined>(), defaultValue: undefined,
})

/** Literal-keyed map keeps the value/config type owned by each kernel preset
 * id available to typed authoring APIs such as seedProperty. */
export const kernelValuePresetCoresById = {
  string: stringValuePresetCore,
  number: numberValuePresetCore,
  boolean: booleanValuePresetCore,
  list: listValuePresetCore,
  'json-list': jsonListValuePresetCore,
  date: dateValuePresetCore,
  url: urlValuePresetCore,
  enum: enumValuePresetCore,
  'strict-enum': strictEnumValuePresetCore,
  ref: refValuePresetCore,
  refList: refListValuePresetCore,
  'optional-string': optionalStringValuePresetCore,
  'optional-number': optionalNumberValuePresetCore,
  'string-list': stringListValuePresetCore,
  'optional-ref': optionalRefValuePresetCore,
  json: jsonValuePresetCore,
  'optional-json': optionalJsonValuePresetCore,
  'raw-json': rawJsonValuePresetCore,
} as const satisfies Readonly<Record<string, AnyValuePresetCore>>

export const kernelValuePresetCores: readonly AnyValuePresetCore[] =
  Object.values(kernelValuePresetCoresById)
