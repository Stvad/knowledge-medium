// @vitest-environment node
/**
 * Fuzz suite for the property-seed declaration layer (PR #364):
 * `src/data/propertySeeds.ts` (`seedProperty` / `isPropertySeedDeclaration`),
 * `src/data/definitionSeeds.ts` (`propertyDefinitionBlockId` /
 * `canonicalPropertySeedProperties` / `isValidSeededDefinition`),
 * `src/data/propertyDefinitionMetadata.ts` (`parsePropertyDefinitionMetadata`),
 * and the kernel preset codecs (`src/data/kernelValuePresetCores.ts`,
 * `src/data/api/valuePresetCore.ts`). See `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics.
 *
 * Everything exercised here is durable post-B' machinery — `legacySchemas`,
 * `buildUnboundPropertySchemas`, and `propertySchemasFacet` are never
 * imported or exercised.
 *
 * Oracles:
 *  - P1 `seedProperty` totality + self-validation: for a valid
 *    `SeedPropertyArgs` domain spanning every kernel preset used by
 *    seeded declarations, `seedProperty` never throws and its result
 *    passes `isPropertySeedDeclaration` (propertySeeds.ts:103-123) — the
 *    runtime boundary a dynamic/public facet contribution must clear or
 *    it is silently dropped (propertySeeds.ts:100-102).
 *  - P2 canonical bag -> metadata round-trip + provenance demotion:
 *    `canonicalPropertySeedProperties` (definitionSeeds.ts:51-69) fed back
 *    through `isValidSeededDefinition` / `parsePropertyDefinitionMetadata`
 *    recovers the seed's own facts exactly when the row's id/workspace
 *    satisfy the deterministic-id equation (definitionSeeds.ts:29-46:
 *    `row.id === propertyDefinitionBlockId(row.workspaceId, seedKey)`),
 *    and demotes to plain `origin: 'user'` with no `seedKey` the moment
 *    either half of that equation is wrong
 *    (propertyDefinitionMetadata.ts:58-67).
 *  - P3 preset codec laws: encode fixpoint
 *    (`encode(decode(encode(v))) === encode(v)`) on each kernel preset's
 *    in-domain value — this is exactly the shape `seedProperty` persists
 *    (`encodedDefaultValue = codec.encode(defaultValue)`, then
 *    materialization stores that encoded form verbatim and
 *    `codec.decode` reconstructs the runtime default —
 *    propertySeeds.ts:190-198, definitionSeeds.ts:65-67 — so a
 *    non-fixpoint codec would make the stored bag diverge from the
 *    runtime default) — plus strict-decode totality (only `CodecError`)
 *    on arbitrary JSON, for every entry in `kernelValuePresetCoresById`
 *    (kernelValuePresetCores.ts:153-171).
 *  - P4 config codec laws: the same two properties directly against
 *    `refConfigCodec` / `enumConfigCodec` (kernelValuePresetCores.ts:5-49).
 *  - P5 `isPropertySeedDeclaration` mutation rejection: every single-field
 *    corruption the validator's own conjuncts check
 *    (propertySeeds.ts:103-123, cited per-corruption below) is rejected,
 *    and the validator never throws on arbitrary input
 *    (propertySeeds.ts:106-123 is a plain boolean expression with no
 *    unguarded access once `isRecord` short-circuits).
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import {
  ChangeScope,
  CodecError,
  isPropertySeedDeclaration,
  seedProperty,
  type AnyPropertySeedDeclaration,
} from '@/data/api'
import {
  propertyDefinitionBlockId,
  canonicalPropertySeedProperties,
  isValidSeededDefinition,
} from '@/data/definitionSeeds'
import {
  parsePropertyDefinitionMetadata,
  propertySchemaOriginForSeedKey,
} from '@/data/propertyDefinitionMetadata'
import { kernelValuePresetCoresById, refConfigCodec, enumConfigCodec } from '@/data/kernelValuePresetCores'
import { makeBlockData } from '@/data/test/factories'

// ──── Small generator pools (kept tiny so the smoke tier stays ~1s) ────

const OWNER_POOL = ['system:kernel-data', 'fuzz-plugin-a', 'fuzz-plugin-b'] as const
const KEY_POOL = ['p1', 'p2', 'p3', 'p4'] as const
const NAME_POOL = ['alpha', 'beta', 'gamma'] as const
const ENUM_VALUE_POOL = ['open', 'done', 'archived', 'draft'] as const
const TARGET_TYPE_POOL = ['project', 'task', 'person'] as const
const WORKSPACE_POOL = ['ws-a', 'ws-b', 'ws-c'] as const

const seedKeyArb = fc.tuple(
  fc.constantFrom(...OWNER_POOL),
  fc.constantFrom(...KEY_POOL),
).map(([owner, key]) => `${owner}/property/${key}`)
const revisionArb = fc.integer({ min: 1, max: 1000 })
const nameArb = fc.constantFrom(...NAME_POOL)
const changeScopeArb = fc.constantFrom(...Object.values(ChangeScope))
const hiddenArb = fc.boolean()
const workspaceIdArb = fc.constantFrom(...WORKSPACE_POOL)

const finiteNumberArb = fc.double({ noNaN: true, noDefaultInfinity: true })
const jsonValueArb = fc.jsonValue({ maxDepth: 2 })

const enumOptionsArb = (minLength: number) =>
  fc.uniqueArray(fc.constantFrom(...ENUM_VALUE_POOL), { minLength, maxLength: 4 })
    .map(values => values.map(value => ({ value, label: value })))

const targetTypesArb = fc.option(
  fc.uniqueArray(fc.constantFrom(...TARGET_TYPE_POOL), { maxLength: 3 }),
  { nil: undefined },
)
const refConfigValueArb: fc.Arbitrary<{ targetTypes?: readonly string[] }> =
  targetTypesArb.map(targetTypes => ({ targetTypes }))

// ──── P1: valid SeedPropertyArgs domain across kernel presets ────

interface PresetArgsCase {
  readonly preset: string
  readonly hasConfig: boolean
  readonly config?: unknown
  readonly hasDefault: boolean
  readonly defaultValue?: unknown
}

/** Required-value preset: config-less, default optionally supplied and
 *  never `undefined` when present (string/number/boolean/string-list/etc). */
const requiredCase = (preset: string, valueArb: fc.Arbitrary<unknown>): fc.Arbitrary<PresetArgsCase> =>
  fc.oneof(
    fc.constant<PresetArgsCase>({ preset, hasConfig: false, hasDefault: false }),
    valueArb.map(defaultValue => ({ preset, hasConfig: false, hasDefault: true, defaultValue })),
  )

/** Absence-aware, config-less preset: default key may be omitted, or
 *  present with a value that may itself be `undefined` (an
 *  explicit-undefined default is distinct from an omitted one —
 *  `hasExplicitDefault`). */
const optionalCase = (preset: string, innerArb: fc.Arbitrary<unknown>): fc.Arbitrary<PresetArgsCase> =>
  fc.oneof(
    fc.constant<PresetArgsCase>({ preset, hasConfig: false, hasDefault: false }),
    fc.option(innerArb, { nil: undefined }).map(defaultValue => (
      { preset, hasConfig: false, hasDefault: true, defaultValue }
    )),
  )

const stringCase = requiredCase('string', fc.string())
const numberCase = requiredCase('number', finiteNumberArb)
const booleanCase = requiredCase('boolean', fc.boolean())
const stringListCase = requiredCase('string-list', fc.array(fc.string(), { maxLength: 5 }))
const jsonCase = requiredCase('json', jsonValueArb)
const optionalStringCase = optionalCase('optional-string', fc.string())
const optionalNumberCase = optionalCase('optional-number', finiteNumberArb)
const optionalJsonCase = optionalCase('optional-json', jsonValueArb)

const enumCase: fc.Arbitrary<PresetArgsCase> = fc.boolean().chain(hasConfig =>
  enumOptionsArb(0).chain(options => {
    const effectiveOptions = hasConfig ? options : []
    const domain = effectiveOptions.length
      ? fc.oneof(fc.constant(''), fc.constantFrom(...effectiveOptions.map(o => o.value)))
      : fc.constant('')
    return fc.record({ hasDefault: fc.boolean(), value: domain }).map(({ hasDefault, value }) => ({
      preset: 'enum',
      hasConfig,
      config: hasConfig ? { options } : undefined,
      hasDefault,
      defaultValue: hasDefault ? value : undefined,
    }))
  }),
)

const strictEnumCase: fc.Arbitrary<PresetArgsCase> = enumOptionsArb(1).chain(options =>
  fc.constantFrom(...options.map(o => o.value)).map(defaultValue => ({
    preset: 'strict-enum', hasConfig: true, config: { options }, hasDefault: true, defaultValue,
  })),
)

const refLikeCase = (preset: string, valueArb: fc.Arbitrary<unknown>): fc.Arbitrary<PresetArgsCase> =>
  fc.record({
    hasConfig: fc.boolean(),
    config: refConfigValueArb,
    hasDefault: fc.boolean(),
    value: valueArb,
  }).map(({ hasConfig, config, hasDefault, value }) => ({
    preset,
    hasConfig,
    config: hasConfig ? config : undefined,
    hasDefault,
    defaultValue: hasDefault ? value : undefined,
  }))

const refCase = refLikeCase('ref', fc.string())
const refListCase = refLikeCase('refList', fc.array(fc.string(), { maxLength: 5 }))

const presetArgsCaseArb: fc.Arbitrary<PresetArgsCase> = fc.oneof(
  stringCase, numberCase, booleanCase, strictEnumCase, enumCase,
  refCase, refListCase, stringListCase, optionalStringCase, optionalNumberCase,
  jsonCase, optionalJsonCase,
)

const validSeedArgsArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  seedKey: seedKeyArb,
  revision: revisionArb,
  name: nameArb,
  changeScope: changeScopeArb,
  hidden: hiddenArb,
  kase: presetArgsCaseArb,
}).map(({ seedKey, revision, name, changeScope, hidden, kase }) => {
  const args: Record<string, unknown> = { seedKey, revision, name, changeScope, hidden, preset: kase.preset }
  if (kase.hasConfig) args.config = kase.config
  if (kase.hasDefault) args.defaultValue = kase.defaultValue
  return args
})

describe('P1: seedProperty totality + self-validation', () => {
  it('never throws on a valid SeedPropertyArgs domain and always yields a self-validating declaration', () => {
    fc.assert(
      fc.property(validSeedArgsArb, args => {
        const declaration = seedProperty(args as never)
        expect(isPropertySeedDeclaration(declaration)).toBe(true)
      }),
      fuzzParams(60),
    )
  })
})

// ──── P2: canonical bag -> metadata round-trip + provenance demotion ────

describe('P2: canonical bag -> metadata round-trip + provenance demotion', () => {
  it("parses back the seed's own facts when the row id/workspace satisfy the deterministic-id equation", () => {
    fc.assert(
      fc.property(validSeedArgsArb, workspaceIdArb, (args, workspaceId) => {
        const seed = seedProperty(args as never) as AnyPropertySeedDeclaration
        const properties = canonicalPropertySeedProperties(seed)
        const row = makeBlockData({
          id: propertyDefinitionBlockId(workspaceId, seed.seedKey),
          workspaceId,
          content: seed.name,
          properties,
        })

        expect(isValidSeededDefinition(row)).toBe(true)
        const metadata = parsePropertyDefinitionMetadata(row)
        expect(metadata).not.toBeNull()
        expect(metadata?.seedKey).toBe(seed.seedKey)
        expect(metadata?.name).toBe(seed.name)
        expect(metadata?.hidden).toBe(seed.hidden)
        expect(metadata?.changeScope).toBe(seed.changeScope)
        expect(metadata?.origin).toBe(propertySchemaOriginForSeedKey(seed.seedKey))
        expect(metadata?.fieldId).toBe(row.id)
      }),
      fuzzParams(40),
    )
  })

  it('demotes to origin "user" with no seedKey when the row id does not match propertyDefinitionBlockId', () => {
    fc.assert(
      fc.property(validSeedArgsArb, workspaceIdArb, fc.uuid(), (args, workspaceId, randomId) => {
        const seed = seedProperty(args as never) as AnyPropertySeedDeclaration
        // Guard the astronomically unlikely uuid collision so the property
        // stays a clean "wrong id" case rather than accidentally testing P2's
        // happy path.
        fc.pre(randomId !== propertyDefinitionBlockId(workspaceId, seed.seedKey))
        const properties = canonicalPropertySeedProperties(seed)
        const row = makeBlockData({ id: randomId, workspaceId, content: seed.name, properties })

        expect(isValidSeededDefinition(row)).toBe(false)
        const metadata = parsePropertyDefinitionMetadata(row)
        expect(metadata).not.toBeNull()
        expect(metadata?.origin).toBe('user')
        expect(metadata?.seedKey).toBeUndefined()
      }),
      fuzzParams(40),
    )
  })

  it("demotes to origin \"user\" with no seedKey when the row workspace does not match the id's minting workspace", () => {
    const distinctWorkspacePairArb = fc.tuple(workspaceIdArb, workspaceIdArb).filter(([a, b]) => a !== b)
    fc.assert(
      fc.property(validSeedArgsArb, distinctWorkspacePairArb, (args, [mintWorkspaceId, rowWorkspaceId]) => {
        const seed = seedProperty(args as never) as AnyPropertySeedDeclaration
        const properties = canonicalPropertySeedProperties(seed)
        const row = makeBlockData({
          id: propertyDefinitionBlockId(mintWorkspaceId, seed.seedKey),
          workspaceId: rowWorkspaceId,
          content: seed.name,
          properties,
        })

        expect(isValidSeededDefinition(row)).toBe(false)
        const metadata = parsePropertyDefinitionMetadata(row)
        expect(metadata).not.toBeNull()
        expect(metadata?.origin).toBe('user')
        expect(metadata?.seedKey).toBeUndefined()
      }),
      fuzzParams(40),
    )
  })
})

// ──── P3: preset codec laws ────

interface PresetCase {
  readonly config: unknown
  readonly value: unknown
}

const presetCaseArbById: Record<string, fc.Arbitrary<PresetCase>> = {
  string: fc.record({ config: fc.constant(undefined), value: fc.string() }),
  number: fc.record({ config: fc.constant(undefined), value: finiteNumberArb }),
  boolean: fc.record({ config: fc.constant(undefined), value: fc.boolean() }),
  list: fc.record({ config: fc.constant(undefined), value: fc.array(jsonValueArb, { maxLength: 5 }) }),
  // Timestamps generated from ints (never Date.now()) — see docblock.
  date: fc.record({
    config: fc.constant(undefined),
    value: fc.option(
      fc.integer({ min: -8_640_000_000_000, max: 8_640_000_000_000 }).map(n => new Date(n)),
      { nil: undefined },
    ),
  }),
  url: fc.record({ config: fc.constant(undefined), value: fc.string() }),
  'optional-string': fc.record({ config: fc.constant(undefined), value: fc.option(fc.string(), { nil: undefined }) }),
  'optional-number': fc.record({
    config: fc.constant(undefined),
    value: fc.option(finiteNumberArb, { nil: undefined }),
  }),
  'string-list': fc.record({ config: fc.constant(undefined), value: fc.array(fc.string(), { maxLength: 5 }) }),
  json: fc.record({ config: fc.constant(undefined), value: jsonValueArb }),
  'optional-json': fc.record({ config: fc.constant(undefined), value: fc.option(jsonValueArb, { nil: undefined }) }),
  'raw-json': fc.record({ config: fc.constant(undefined), value: fc.option(jsonValueArb, { nil: undefined }) }),
  enum: enumOptionsArb(0).chain(options => fc.record({
    config: fc.constant({ options }),
    value: options.length
      ? fc.oneof(fc.constant(''), fc.constantFrom(...options.map(o => o.value)))
      : fc.constant(''),
  })),
  'strict-enum': enumOptionsArb(1).chain(options => fc.record({
    config: fc.constant({ options }),
    value: fc.constantFrom(...options.map(o => o.value)),
  })),
  ref: refConfigValueArb.chain(config => fc.record({ config: fc.constant(config), value: fc.string() })),
  refList: refConfigValueArb.chain(config => fc.record({
    config: fc.constant(config),
    value: fc.array(fc.string(), { maxLength: 5 }),
  })),
  'optional-ref': refConfigValueArb.chain(config => fc.record({
    config: fc.constant(config),
    value: fc.option(fc.string(), { nil: undefined }),
  })),
}

describe('P3: kernel preset codec laws', () => {
  for (const [id, core] of Object.entries(kernelValuePresetCoresById)) {
    const caseArb = presetCaseArbById[id]
    if (!caseArb) throw new Error(`no P3 case generator registered for kernel preset ${JSON.stringify(id)}`)

    it(`${id}: encode fixpoint (encode(decode(encode(v))) === encode(v))`, () => {
      fc.assert(
        fc.property(caseArb, ({ config, value }) => {
          const codec = core.build(config as never)
          const encodedOnce = codec.encode(value as never)
          const decoded = codec.decode(encodedOnce)
          const encodedTwice = codec.encode(decoded)
          expect(encodedTwice).toEqual(encodedOnce)
        }),
        fuzzParams(40),
      )
    })

    it(`${id}: decode totality (returns or throws only CodecError)`, () => {
      const configOnlyArb = caseArb.map(c => c.config)
      fc.assert(
        fc.property(configOnlyArb, fc.jsonValue({ maxDepth: 3 }), (config, json) => {
          const codec = core.build(config as never)
          try {
            codec.decode(json)
          } catch (e) {
            expect(e).toBeInstanceOf(CodecError)
          }
        }),
        fuzzParams(40),
      )
    })
  }
})

// ──── P4: config codec round-trips ────

describe('P4: config codec round-trips', () => {
  it('refConfigCodec: encode fixpoint on valid configs', () => {
    fc.assert(
      fc.property(refConfigValueArb, config => {
        const encodedOnce = refConfigCodec.encode(config)
        const decoded = refConfigCodec.decode(encodedOnce)
        const encodedTwice = refConfigCodec.encode(decoded)
        expect(encodedTwice).toEqual(encodedOnce)
      }),
      fuzzParams(40),
    )
  })

  it('refConfigCodec: decode totality on arbitrary JSON (only CodecError)', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), json => {
        try {
          refConfigCodec.decode(json)
        } catch (e) {
          expect(e).toBeInstanceOf(CodecError)
        }
      }),
      fuzzParams(60),
    )
  })

  it('enumConfigCodec: encode fixpoint on valid configs', () => {
    fc.assert(
      fc.property(enumOptionsArb(0), options => {
        const config = { options }
        const encodedOnce = enumConfigCodec.encode(config)
        const decoded = enumConfigCodec.decode(encodedOnce)
        const encodedTwice = enumConfigCodec.encode(decoded)
        expect(encodedTwice).toEqual(encodedOnce)
      }),
      fuzzParams(40),
    )
  })

  it('enumConfigCodec: decode totality on arbitrary JSON (only CodecError)', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), json => {
        try {
          enumConfigCodec.decode(json)
        } catch (e) {
          expect(e).toBeInstanceOf(CodecError)
        }
      }),
      fuzzParams(60),
    )
  })
})

// ──── P5: isPropertySeedDeclaration mutation rejection ────

interface Corruption {
  readonly label: string
  readonly apply: (d: AnyPropertySeedDeclaration) => unknown
}

const deleteKey = (d: AnyPropertySeedDeclaration, key: string): unknown => {
  const copy: Record<string, unknown> = { ...d }
  delete copy[key]
  return copy
}

const CORRUPTIONS: readonly Corruption[] = [
  // seedKey grammar: /^[^/]+\/property\/[^/]+$/ (propertySeeds.ts:73-74),
  // checked at propertySeeds.ts:107.
  { label: 'seedKey: no /property/ segment', apply: d => ({ ...d, seedKey: 'not-a-seed-key' }) },
  { label: 'seedKey: empty owner', apply: d => ({ ...d, seedKey: '/property/key' }) },
  { label: 'seedKey: empty key', apply: d => ({ ...d, seedKey: 'owner/property/' }) },
  // revision: Number.isInteger(...) && > 0 (propertySeeds.ts:108-109).
  { label: 'revision: zero', apply: d => ({ ...d, revision: 0 }) },
  { label: 'revision: negative', apply: d => ({ ...d, revision: -1 }) },
  { label: 'revision: non-integer', apply: d => ({ ...d, revision: 1.5 }) },
  { label: 'revision: string', apply: d => ({ ...d, revision: '1' }) },
  // name: typeof === 'string' && trim().length > 0 (propertySeeds.ts:110).
  { label: 'name: empty', apply: d => ({ ...d, name: '' }) },
  { label: 'name: whitespace only', apply: d => ({ ...d, name: '   ' }) },
  // presetId: typeof === 'string' && trim().length > 0 (propertySeeds.ts:111).
  { label: 'presetId: empty', apply: d => ({ ...d, presetId: '' }) },
  // config own-key required (propertySeeds.ts:112).
  { label: 'config: own-key deleted', apply: d => deleteKey(d, 'config') },
  // encodedConfig: own key + isRecord + isJsonValue (propertySeeds.ts:113,
  // isJsonValue at propertySeeds.ts:76-98).
  { label: 'encodedConfig: string', apply: d => ({ ...d, encodedConfig: 'nope' }) },
  { label: 'encodedConfig: array', apply: d => ({ ...d, encodedConfig: [] }) },
  { label: 'encodedConfig: null', apply: d => ({ ...d, encodedConfig: null }) },
  { label: 'encodedConfig: contains undefined member', apply: d => ({ ...d, encodedConfig: { a: undefined } }) },
  { label: 'encodedConfig: contains NaN', apply: d => ({ ...d, encodedConfig: { a: Number.NaN } }) },
  {
    label: 'encodedConfig: contains Infinity',
    apply: d => ({ ...d, encodedConfig: { a: Number.POSITIVE_INFINITY } }),
  },
  {
    label: 'encodedConfig: cyclic',
    apply: d => {
      const o: Record<string, unknown> = {}
      o.self = o
      return { ...d, encodedConfig: o }
    },
  },
  // codec: isRecord (propertySeeds.ts:114).
  { label: 'codec: missing', apply: d => deleteKey(d, 'codec') },
  // codec.type: typeof === 'string' && trim().length > 0 (propertySeeds.ts:115).
  { label: 'codec: type empty string', apply: d => ({ ...d, codec: { ...d.codec, type: '' } }) },
  // codec.encode: typeof === 'function' (propertySeeds.ts:116).
  { label: 'codec: encode not a function', apply: d => ({ ...d, codec: { ...d.codec, encode: 'nope' } }) },
  // codec.decode: typeof === 'function' (propertySeeds.ts:117).
  { label: 'codec: decode not a function', apply: d => ({ ...d, codec: { ...d.codec, decode: 'nope' } }) },
  // defaultValue: own-key required (propertySeeds.ts:118).
  { label: 'defaultValue: own-key deleted', apply: d => deleteKey(d, 'defaultValue') },
  // changeScope: isChangeScope(...) (propertySeeds.ts:119).
  { label: 'changeScope: invalid enum member', apply: d => ({ ...d, changeScope: 'bogus-scope' }) },
  // hidden: typeof === 'boolean' (propertySeeds.ts:120).
  { label: 'hidden: string', apply: d => ({ ...d, hidden: 'yes' }) },
  // hasExplicitDefault: typeof === 'boolean' (propertySeeds.ts:121).
  { label: 'hasExplicitDefault: non-boolean', apply: d => ({ ...d, hasExplicitDefault: 'true' }) },
  // encodedDefaultValue: own-key required (propertySeeds.ts:122).
  { label: 'encodedDefaultValue: own-key deleted', apply: d => deleteKey(d, 'encodedDefaultValue') },
  // hasExplicitDefault true requires isJsonValue(encodedDefaultValue)
  // (propertySeeds.ts:123).
  {
    label: 'encodedDefaultValue: NaN with explicit default',
    apply: d => ({ ...d, hasExplicitDefault: true, encodedDefaultValue: Number.NaN }),
  },
  {
    label: 'encodedDefaultValue: array with undefined member',
    apply: d => ({ ...d, hasExplicitDefault: true, encodedDefaultValue: [undefined] }),
  },
  {
    label: 'encodedDefaultValue: cyclic',
    apply: d => {
      const arr: unknown[] = []
      arr.push(arr)
      return { ...d, hasExplicitDefault: true, encodedDefaultValue: arr }
    },
  },
]

describe('P5: isPropertySeedDeclaration mutation rejection', () => {
  it('rejects every single-field corruption the validator checks', () => {
    fc.assert(
      fc.property(validSeedArgsArb, fc.constantFrom(...CORRUPTIONS), (args, corruption) => {
        const declaration = seedProperty(args as never) as AnyPropertySeedDeclaration
        const corrupted = corruption.apply(declaration)
        expect(isPropertySeedDeclaration(corrupted)).toBe(false)
      }),
      fuzzParams(60),
    )
  })

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), value => {
        expect(() => isPropertySeedDeclaration(value)).not.toThrow()
      }),
      fuzzParams(60),
    )
  })
})
