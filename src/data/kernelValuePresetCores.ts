import {CodecError, codecs, type Codec, type RefCodecOptions} from './api/codecs'
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

export const stringValuePresetCore = definePresetCore<string>({
    id: 'string', build: () => codecs.string, defaultValue: '',
  })
export const numberValuePresetCore = definePresetCore<number>({
    id: 'number', build: () => codecs.number, defaultValue: 0,
  })
export const booleanValuePresetCore = definePresetCore<boolean>({
    id: 'boolean', build: () => codecs.boolean, defaultValue: false,
  })
export const listValuePresetCore = definePresetCore<unknown[]>({
    id: 'list', build: () => codecs.list(codecs.unsafeIdentity<unknown>()), defaultValue: [],
  })
export const dateValuePresetCore = definePresetCore<Date | undefined>({
    id: 'date', build: () => codecs.date, defaultValue: undefined,
  })
export const urlValuePresetCore = definePresetCore<string>({
    id: 'url', build: () => codecs.url, defaultValue: '',
  })
export const enumValuePresetCore = definePresetCore<string>({
    id: 'enum', build: () => codecs.enum<string>([]), defaultValue: '',
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

export const kernelValuePresetCores: readonly AnyValuePresetCore[] = [
  stringValuePresetCore,
  numberValuePresetCore,
  booleanValuePresetCore,
  listValuePresetCore,
  dateValuePresetCore,
  urlValuePresetCore,
  enumValuePresetCore,
  refValuePresetCore,
  refListValuePresetCore,
]
