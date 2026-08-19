import {describe, expect, expectTypeOf, it, vi} from 'vitest'
import {
  ChangeScope,
  CodecError,
  definePresetCore,
  seedProperty,
  type Codec,
  type PropertyHandle,
} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {resolveFacetRuntimeSync} from '@/facets/facet'

interface Config {readonly prefix: string}

const configCodec: Codec<Config> = {
  type: 'test-config',
  encode: config => ({prefix: config.prefix.trim()}),
  decode: value => {
    if (
      value === null || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as {prefix?: unknown}).prefix !== 'string'
    ) throw new CodecError('{prefix:string}', value)
    return {prefix: (value as {prefix: string}).prefix}
  },
}

const prefixedCore = definePresetCore<string, Config>({
  id: 'test:prefixed',
  configCodec,
  defaultConfig: {prefix: 'default:'},
  defaultValue: 'default:value',
  build: config => ({
    type: 'test:prefixed',
    encode: value => `${config.prefix}${value}`,
    decode: value => {
      if (typeof value !== 'string' || !value.startsWith(config.prefix)) {
        throw new CodecError(`string prefixed by ${config.prefix}`, value)
      }
      return value.slice(config.prefix.length)
    },
  }),
})

describe('seedProperty', () => {
  it('returns the contributed declaration as a typed workspace-agnostic handle', () => {
    const declaration = seedProperty({
      seedKey: 'system:test/property/title',
      revision: 1,
      name: 'test:title',
      preset: prefixedCore,
      config: {prefix: ' normalized: '},
      defaultValue: 'hello',
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
    })

    expectTypeOf(declaration).toMatchTypeOf<PropertyHandle<string>>()
    expect(declaration).toMatchObject({
      seedKey: 'system:test/property/title',
      revision: 1,
      name: 'test:title',
      presetId: 'test:prefixed',
      config: {prefix: 'normalized:'},
      encodedConfig: {prefix: 'normalized:'},
      defaultValue: 'hello',
      hasExplicitDefault: true,
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
    })
    expect(declaration.codec.encode('value')).toBe('normalized:value')
    expect(declaration.encodedDefaultValue).toBe('normalized:hello')
    expect('fieldId' in declaration).toBe(false)
    expect('workspaceId' in declaration).toBe(false)

    const runtime = resolveFacetRuntimeSync([definitionSeedsFacet.of(declaration)])
    expect(runtime.read(definitionSeedsFacet)).toEqual([declaration])

    const duplicateRuntime = resolveFacetRuntimeSync([
      definitionSeedsFacet.of(declaration),
      definitionSeedsFacet.of(declaration),
    ])
    expect(duplicateRuntime.read(definitionSeedsFacet)).toEqual([declaration, declaration])
  })

  it('infers kernel preset value types and rejects caller-selected mismatches', () => {
    const inferred = seedProperty({
      seedKey: 'system:test/property/inferred-title',
      revision: 1,
      name: 'test:inferred-title',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    expectTypeOf(inferred).toMatchTypeOf<PropertyHandle<string>>()

    seedProperty<number>({
      seedKey: 'system:test/property/lying-title',
      revision: 1,
      name: 'test:lying-title',
      // @ts-expect-error kernel preset ids own their value type
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })

    const missingStrictEnumConfig = () => seedProperty<'open'>({
      seedKey: 'system:test/property/missing-strict-options',
      revision: 1,
      name: 'test:missing-strict-options',
      // @ts-expect-error strict-enum declarations must provide their option config
      preset: 'strict-enum',
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
    })
    void missingStrictEnumConfig
  })

  it('normalizes default config and distinguishes omitted from explicit undefined defaults', () => {
    const omitted = seedProperty({
      seedKey: 'system:test/property/omitted',
      revision: 1,
      name: 'test:omitted',
      preset: prefixedCore,
      changeScope: ChangeScope.BlockDefault,
    })
    const explicitUndefined = seedProperty({
      seedKey: 'system:test/property/undefined',
      revision: 1,
      name: 'test:undefined',
      preset: 'optional-string',
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })

    expect(omitted.config).toEqual({prefix: 'default:'})
    expect(omitted.defaultValue).toBe('default:value')
    expect(omitted.hasExplicitDefault).toBe(false)
    expect(omitted.encodedDefaultValue).toBeUndefined()
    expect(explicitUndefined.hasExplicitDefault).toBe(true)
    expect(explicitUndefined.encodedDefaultValue).toBeNull()
  })

  it.each([0, -1, 1.5])('rejects non-positive-integer revision %s', revision => {
    expect(() => seedProperty({
      seedKey: 'system:test/property/title',
      revision,
      name: 'test:title',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('positive integer')
  })

  it('rejects invalid config before building the declaration', () => {
    expect(() => seedProperty({
      seedKey: 'system:test/property/title',
      revision: 1,
      name: 'test:title',
      preset: prefixedCore,
      config: null as never,
      changeScope: ChangeScope.BlockDefault,
    })).toThrow()
  })

  it('rejects a custom preset core without a stable id', () => {
    expect(() => seedProperty({
      seedKey: 'system:test/property/blank-core',
      revision: 1,
      name: 'test:blank-core',
      preset: {...prefixedCore, id: '   '},
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('preset id is required')
  })

  it('rejects custom cores whose config or default encoding is not JSON', () => {
    const badConfigCore = definePresetCore<string, {value: bigint}>({
      id: 'test:bad-config',
      configCodec: {
        type: 'test:bad-config',
        encode: value => ({value: value.value}),
        decode: () => ({value: 1n}),
      },
      defaultConfig: {value: 1n},
      defaultValue: '',
      build: () => prefixedCore.build({prefix: ''}),
    })
    expect(() => seedProperty({
      seedKey: 'system:test/property/bad-config',
      revision: 1,
      name: 'test:bad-config',
      preset: badConfigCore,
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('config must encode a JSON object')

    const badDefaultCore = definePresetCore<bigint>({
      id: 'test:bad-default',
      defaultValue: 0n,
      build: () => ({
        type: 'test:bad-default',
        encode: value => value,
        decode: value => value as bigint,
      }),
    })
    expect(() => seedProperty({
      seedKey: 'system:test/property/bad-default',
      revision: 1,
      name: 'test:bad-default',
      preset: badDefaultCore,
      defaultValue: 1n,
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('default must encode a JSON value')

    expect(() => seedProperty<unknown[]>({
      seedKey: 'system:test/property/sparse-default',
      revision: 1,
      name: 'test:sparse-default',
      preset: 'json',
      defaultValue: Array(1),
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('default must encode a JSON value')
  })

  it('drops malformed public facet contributions without dropping valid siblings', () => {
    const valid = seedProperty({
      seedKey: 'system:test/property/valid',
      revision: 1,
      name: 'test:valid',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    const malformed = {...valid, seedKey: 'not-a-seed-key', revision: 0, changeScope: 'bogus'}
    const nonJson = {...valid, encodedConfig: {nested: 1n}}
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const runtime = resolveFacetRuntimeSync([
      definitionSeedsFacet.of(malformed as never),
      definitionSeedsFacet.of(nonJson as never),
      definitionSeedsFacet.of(valid),
    ])

    expect(runtime.read(definitionSeedsFacet)).toEqual([valid])
    expect(error).toHaveBeenCalledWith(
      'Dropping invalid contribution for facet "data.definition-seeds"',
      expect.anything(),
    )
    error.mockRestore()
  })

  it.each([
    'kindless-key',
    '/property/title',
    'system:test/property/',
    'system:test/type/title',
    'system:test/property/nested/key',
  ])('rejects seed key outside the property namespace: %s', seedKey => {
    expect(() => seedProperty({
      seedKey,
      revision: 1,
      name: 'test:title',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })).toThrow('<owner>/property/<stable-key>')
  })
})
