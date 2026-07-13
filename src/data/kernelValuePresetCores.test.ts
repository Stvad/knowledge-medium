import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from './kernelDataExtension'
import {stringValuePresetCore} from './kernelValuePresetCores'
import { valuePresetCoresFacet } from './facets'
import {definePresetCore} from './api/valuePresetCore'
import { defineSplitPreset, joinValuePreset, type ValuePresetPresentation } from './api/valuePresets'
import {readValuePresets} from './valuePresetRegistry'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'

describe('kernel value preset split', () => {
  it('registers codec cores in the data runtime without React presentation', () => {
    const runtime = resolveFacetRuntimeSync(kernelDataExtension)
    const stringCore = runtime.read(valuePresetCoresFacet).get('string')

    expect(stringCore?.build(undefined).type).toBe('string')
    expect(stringCore).not.toHaveProperty('Editor')
    expect(stringCore).not.toHaveProperty('Glyph')

    const refCore = runtime.read(valuePresetCoresFacet).get('ref')
    expect(() => refCore?.configCodec?.decode({targetTypes: 'not-an-array'})).toThrow()

    const cores = runtime.read(valuePresetCoresFacet)
    expect([...cores.keys()]).toEqual(expect.arrayContaining([
      'optional-string', 'optional-number', 'string-list',
      'optional-ref', 'json', 'optional-json',
    ]))
    expect(cores.get('optional-string')?.build(undefined).encode(undefined)).toBeNull()
    expect(cores.get('optional-number')?.build(undefined).decode(null)).toBeUndefined()
    expect(() => cores.get('string-list')?.build(undefined).decode(['ok', 1])).toThrow()
    const optionalRef = cores.get('optional-ref')?.build({targetTypes: ['place']})
    expect(optionalRef?.type).toBe('ref')
    expect(optionalRef?.encode(undefined)).toBeNull()
    expect(cores.get('json')?.defaultValue).toBeNull()
    expect(cores.get('optional-json')?.build(undefined).decode(null)).toBeUndefined()

    const enumCore = cores.get('enum')!
    const enumConfig = enumCore.configCodec!.decode({
      options: [{value: 'open', label: 'Open'}],
    })
    const enumCodec = enumCore.build(enumConfig)
    expect(enumCodec.decode(enumCodec.encode(enumCore.defaultValue))).toBe(enumCore.defaultValue)
    expect(enumCodec.where?.encode(enumCore.defaultValue)).toBe('')
    expect(enumCodec.encode('open')).toBe('open')
    expect(enumCodec.decode('removed')).toBe('removed')
    expect(() => enumCodec.encode('removed')).toThrow()
    expect(() => enumCore.configCodec!.decode({options: [{value: 1, label: 'Bad'}]})).toThrow()
  })

  it('joins UI presentation onto the same core by preset id', () => {
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelValuePresetsExtension,
    ])
    const stringCore = runtime.read(valuePresetCoresFacet).get('string')
    const stringPreset = readValuePresets(runtime).get('string')

    expect(stringPreset?.build).toBe(stringCore?.build)
    expect(stringPreset?.Editor).toBeTypeOf('function')
    expect(stringPreset?.label).toBe('Plain text')

    const replacement = definePresetCore<string>({
      id: 'string',
      build: () => ({
        type: 'replacement-string',
        encode: value => value,
        decode: value => String(value),
      }),
      defaultValue: 'replacement',
    })
    runtime.setRuntimeContributions(valuePresetCoresFacet, 'test:replacement', [replacement])
    const replacedPreset = readValuePresets(runtime).get('string')
    expect(replacedPreset?.build(undefined).type).toBe('replacement-string')
    expect(replacedPreset?.Editor).toBe(stringPreset?.Editor)
  })

  it('rejects a presentation joined to the wrong core id', () => {
    const runtime = resolveFacetRuntimeSync(kernelDataExtension)
    const core = runtime.read(valuePresetCoresFacet).get('string')!
    const presentation = {
      id: 'other',
      label: 'Other',
      Editor: () => { throw new Error('not rendered') },
    } satisfies ValuePresetPresentation<string>

    expect(() => joinValuePreset(core, presentation)).toThrow(/id mismatch/)

    const numberPresentation = {
      id: 'string',
      label: 'Wrong value type',
      Editor: props => {
        void props.value.toFixed()
        throw new Error('not rendered')
      },
    } satisfies ValuePresetPresentation<number>
    const assertMismatchRejected = () => {
      // @ts-expect-error core-owned TValue prevents independently erased mismatches
      defineSplitPreset(stringValuePresetCore, numberPresentation)
    }
    void assertMismatchRejected
  })
})
