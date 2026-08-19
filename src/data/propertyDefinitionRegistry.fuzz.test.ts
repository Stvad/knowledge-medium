// @vitest-environment node
/**
 * Fuzz: the property-definition registry + workspace-bound resolver (PR #364,
 * schema-unification Slice B). Random universes of code-owned seed
 * declarations and projected definition rows (seed-provenanced, poisoned,
 * user, renamed, foreign-workspace) are built into a snapshot and swept for
 * the invariants the two modules maintain BY HAND across each other:
 *
 * - first-wins same-name seed drop (propertyDefinitionRegistry.ts:47-65):
 *   differential against a five-line reference model;
 * - name-winner uniqueness (propertyDefinitionRegistry.ts:130-135 sorts by
 *   (createdAt, fieldId); propertySchemaResolution.ts:298-300 rejects
 *   non-winners as 'shadowed'): at most one row per effective name resolves,
 *   and it is the group head;
 * - resolution-path agreement: a schema resolved through resolve(handle),
 *   resolve(name), or resolveField(fieldId) must round-trip through the
 *   other two paths to the same resolved schema — three hand-written
 *   lookups over the same snapshot (propertySchemaResolution.ts:241-308);
 * - kept-seed case model: v1 seeds are unshadowable and non-renamable
 *   (propertyDefinitionRegistry.ts:98-128), so a KEPT declaration resolves
 *   iff its deterministic id is unoccupied or occupied by its own
 *   provenance-valid row; a foreign occupant invalidates it
 *   ('definition-unavailable', propertySchemaResolution.ts:249-251), and
 *   'shadowed'/'ambiguous' are unreachable for kept handles;
 * - insertion-order independence: the snapshot is a pure function of the
 *   projected-row SET (winner sort is total via the fieldId tie-break,
 *   propertyDefinitionRegistry.ts:130-135), so permuting projection order
 *   must not change any output map;
 * - boundary totality + the strict-write seam: resolveBoundary never throws
 *   and fails closed on forged ResolvedPropertySchema identities
 *   (propertySchemaResolution.ts:330-335); for the no-snapshot
 *   handle-trusting resolver, a plugin handle reads through a decode
 *   FALLBACK (garbage decodes to the default, propertySchemaResolution.ts:
 *   104-123) but requireWritablePropertySchema must recover the STRICT
 *   pre-image so a write can never silently clobber an undecodable stored
 *   value (propertySchemaResolution.ts:389-407).
 *
 * The transitional dual-path (direct facet registrations / legacy map, née
 * `legacySchemas`) was deleted in the B′ slice (docs/schema-unification.html
 * §5.2 rev 5) and then the `legacySchemas` parameter itself was removed from
 * `buildPropertyDefinitionRegistry` once nothing fed it (Slice D) — this
 * suite survived both deletions unchanged.
 */
import fc from 'fast-check'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  PropertySchemaIdentityError,
  type AnyPropertySchema,
  type PropertyHandle,
  type ResolvedPropertySchema,
} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {
  buildPropertyDefinitionRegistry,
  type ProjectedPropertyDefinition,
  type PropertyDefinitionRegistrySnapshot,
} from '@/data/propertyDefinitionRegistry'
import {
  propertySchemaResolverForWorkspace,
  requireWritablePropertySchema,
  type PropertySchemaResolver,
} from '@/data/internals/propertySchemaResolution'
import {seedProperty, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {fuzzParams} from '@/test/fuzz'

const WS = 'ws-registry-fuzz'
const OTHER_WS = 'ws-registry-fuzz-foreign'

// Two kernel-owned and two plugin-owned keys so both origin branches of the
// handle-trusting resolver (unconditional trust vs decode fallback,
// propertySchemaResolution.ts:168-171) come up.
const SEED_KEYS = [
  'system:kernel-data/property/fuzz-p0',
  'system:kernel-data/property/fuzz-p1',
  'fuzz-plugin-a/property/fuzz-p2',
  'fuzz-plugin-b/property/fuzz-p3',
] as const

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const

// Declarations are memoized so the same (key, name, preset) spec yields the
// same OBJECT across the two builds of the permutation property — resolver
// identity checks (input !== declaration, propertySchemaResolution.ts:244)
// are reference-based, exactly like production module-scope declarations.
const seedMemo = new Map<string, AnyPropertySeedDeclaration>()
const seedFor = (key: number, name: number, preset: number): AnyPropertySeedDeclaration => {
  const memoKey = `${key}:${name}:${preset}`
  const cached = seedMemo.get(memoKey)
  if (cached) return cached
  const base = {seedKey: SEED_KEYS[key]!, revision: 1, name: NAMES[name]!}
  const built: AnyPropertySeedDeclaration =
    preset === 0
      ? seedProperty({...base, preset: 'string', defaultValue: 'seed-default', changeScope: ChangeScope.BlockDefault})
      : preset === 1
        ? seedProperty({...base, preset: 'number', changeScope: ChangeScope.UserPrefs, hidden: true})
        : seedProperty({
            ...base,
            preset: 'strict-enum',
            config: {options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]},
            defaultValue: 'a',
            changeScope: ChangeScope.Automation,
          })
  seedMemo.set(memoKey, built)
  return built
}

const USER_FIELD_IDS = ['field-u0', 'field-u1', 'field-u2', 'field-u3'] as const

// Row-attached behavior schemas, memoized per fieldId for cross-build identity.
const rowSchemaMemo = new Map<string, AnyPropertySchema>()
const rowSchemaFor = (fieldId: string, name: string): AnyPropertySchema => {
  const memoKey = `${fieldId}:${name}`
  const cached = rowSchemaMemo.get(memoKey)
  if (cached) return cached
  const built = defineProperty(name, {
    codec: codecs.string,
    defaultValue: `row-default:${fieldId}`,
    changeScope: ChangeScope.BlockDefault,
  })
  rowSchemaMemo.set(memoKey, built)
  return built
}

// Plain (non-handle, non-resolved) schemas for boundary probing.
const plainSchemaMemo = new Map<string, AnyPropertySchema>()
const plainSchemaFor = (name: string): AnyPropertySchema => {
  const cached = plainSchemaMemo.get(name)
  if (cached) return cached
  const built = defineProperty(name, {
    codec: codecs.number,
    defaultValue: -1,
    changeScope: ChangeScope.UserPrefs,
  })
  plainSchemaMemo.set(name, built)
  return built
}

interface SeedSpec {readonly key: number; readonly name: number; readonly preset: number}
type RowSpec =
  | {
      readonly kind: 'seed-row'
      readonly key: number
      /** 'own' = provenance-valid materialized row; 'none' = a foreign/user
       * occupant of the deterministic id (a seedKey that fails the id
       * equation parses to user provenance, propertyDefinitionMetadata.ts:58). */
      readonly provenance: 'own' | 'none'
      readonly name: number
      readonly createdAt: number
      readonly withSchema: boolean
      readonly foreign: boolean
    }
  | {
      readonly kind: 'user-row'
      readonly id: number
      readonly name: number
      readonly createdAt: number
      readonly withSchema: boolean
      readonly foreign: boolean
    }

const seedSpecArb = fc.array(
  fc.record({key: fc.nat(SEED_KEYS.length - 1), name: fc.nat(NAMES.length - 1), preset: fc.nat(2)}),
  {maxLength: 6},
)

const rowSpecArb = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('seed-row' as const),
      key: fc.nat(SEED_KEYS.length - 1),
      provenance: fc.constantFrom('own' as const, 'none' as const),
      name: fc.nat(NAMES.length - 1),
      createdAt: fc.nat(3),
      withSchema: fc.boolean(),
      foreign: fc.oneof({arbitrary: fc.constant(false), weight: 9}, {arbitrary: fc.constant(true), weight: 1}),
    }),
    fc.record({
      kind: fc.constant('user-row' as const),
      id: fc.nat(USER_FIELD_IDS.length - 1),
      name: fc.nat(NAMES.length - 1),
      createdAt: fc.nat(3),
      withSchema: fc.boolean(),
      foreign: fc.oneof({arbitrary: fc.constant(false), weight: 9}, {arbitrary: fc.constant(true), weight: 1}),
    }),
  ),
  {maxLength: 8},
)

interface Universe {
  readonly seeds: readonly AnyPropertySeedDeclaration[]
  readonly rows: ReadonlyArray<readonly [string, ProjectedPropertyDefinition]>
}

/** Materialize specs into build inputs. Seed specs are deduped by seedKey
 * (duplicate keys THROW by contract, propertyDefinitionRegistry.ts:44-46 —
 * unique-key inputs are the production precondition; the throw itself is
 * pinned by an example test). Rows are deduped by fieldId first-wins so the
 * universe is a well-defined SET and permutation comparison is meaningful. */
const buildUniverse = (seedSpecs: readonly SeedSpec[], rowSpecs: readonly RowSpec[]): Universe => {
  const seeds: AnyPropertySeedDeclaration[] = []
  const seenKeys = new Set<number>()
  for (const spec of seedSpecs) {
    if (seenKeys.has(spec.key)) continue
    seenKeys.add(spec.key)
    seeds.push(seedFor(spec.key, spec.name, spec.preset))
  }
  const rows = new Map<string, ProjectedPropertyDefinition>()
  for (const spec of rowSpecs) {
    const workspaceId = spec.foreign ? OTHER_WS : WS
    const fieldId = spec.kind === 'seed-row'
      ? propertyDefinitionBlockId(workspaceId, SEED_KEYS[spec.key]!)
      : USER_FIELD_IDS[spec.id]!
    if (rows.has(fieldId)) continue
    const name = NAMES[spec.name]!
    const metadata: PropertyDefinitionMetadata = {
      fieldId,
      workspaceId,
      createdAt: spec.createdAt,
      name,
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: spec.kind === 'seed-row' && spec.provenance === 'own'
        ? SEED_KEYS[spec.key]!.startsWith('system:kernel-data/') ? 'kernel' : `plugin:${SEED_KEYS[spec.key]!.split('/')[0]!}`
        : 'user',
      ...(spec.kind === 'seed-row' && spec.provenance === 'own' ? {seedKey: SEED_KEYS[spec.key]!} : {}),
    }
    rows.set(fieldId, {
      metadata,
      ...(spec.withSchema ? {schema: rowSchemaFor(fieldId, name)} : {}),
    })
  }
  return {seeds, rows: [...rows.entries()]}
}

const buildSnapshot = (universe: Universe, rowOrder?: readonly number[]): PropertyDefinitionRegistrySnapshot => {
  const entries = rowOrder ? rowOrder.map(index => universe.rows[index]!) : universe.rows
  return buildPropertyDefinitionRegistry({
    workspaceId: WS,
    projectedDefinitions: new Map(entries),
    seeds: universe.seeds,
  })
}

const resolverFor = (snapshot: PropertyDefinitionRegistrySnapshot): PropertySchemaResolver =>
  propertySchemaResolverForWorkspace(snapshot, WS)

/** Raw per-name declaration counts over the KEPT seed set, as the boot path
 * computes them for the handle-trusting resolver. */
const seedNameCounts = (seeds: readonly AnyPropertySeedDeclaration[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const seed of seeds) counts.set(seed.name, (counts.get(seed.name) ?? 0) + 1)
  return counts
}

const universeArb = fc
  .record({seedSpecs: seedSpecArb, rowSpecs: rowSpecArb})
  .map(({seedSpecs, rowSpecs}) => buildUniverse(seedSpecs, rowSpecs))

describe('property definition registry + resolver (fuzz)', () => {
  // indexSeeds logs each dropped same-name collider by design
  // (propertyDefinitionRegistry.ts:56-62); silence it for the sweep.
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterAll(() => {
    vi.restoreAllMocks()
  })

  it('build is total and structurally well-formed; seed drop matches the first-wins model', () => {
    fc.assert(
      fc.property(universeArb, universe => {
        const snapshot = buildSnapshot(universe)

        // First-wins same-name drop, reference model
        // (propertyDefinitionRegistry.ts:47-65).
        const expectedKept: AnyPropertySeedDeclaration[] = []
        const takenNames = new Set<string>()
        for (const seed of universe.seeds) {
          if (takenNames.has(seed.name)) continue
          takenNames.add(seed.name)
          expectedKept.push(seed)
        }
        expect([...snapshot.seedsByKey.values()]).toEqual(expectedKept)
        for (const seed of expectedKept) {
          expect(snapshot.seedsByKey.get(seed.seedKey)).toBe(seed)
        }

        // Only same-workspace rows project (propertyDefinitionRegistry.ts:97),
        // and a kept seed's row is pinned to its declared name
        // (propertyDefinitionRegistry.ts:98-106).
        const sameWsRows = universe.rows.filter(([, row]) => row.metadata.workspaceId === WS)
        expect(snapshot.definitionsByFieldId.size).toBe(sameWsRows.length)
        for (const [fieldId, row] of sameWsRows) {
          const definition = snapshot.definitionsByFieldId.get(fieldId)
          expect(definition).toBeDefined()
          const declared = row.metadata.seedKey
            ? snapshot.seedsByKey.get(row.metadata.seedKey)
            : undefined
          expect(definition!.name).toBe(declared ? declared.name : row.metadata.name)
        }

        // Name groups: members carry the group's name, sorted by
        // (createdAt, fieldId) (propertyDefinitionRegistry.ts:130-135), and a
        // user/foreign-provenance row never competes at a kept seed's
        // declared name (propertyDefinitionRegistry.ts:111-128).
        const keptNames = new Set(expectedKept.map(seed => seed.name))
        for (const [name, group] of snapshot.definitionsByName) {
          expect(group.length).toBeGreaterThan(0)
          for (const definition of group) expect(definition.name).toBe(name)
          for (let index = 1; index < group.length; index += 1) {
            const previous = group[index - 1]!
            const current = group[index]!
            expect(
              previous.createdAt < current.createdAt ||
              (previous.createdAt === current.createdAt && previous.fieldId < current.fieldId),
            ).toBe(true)
          }
          if (keptNames.has(name)) {
            for (const definition of group) {
              expect(definition.seedKey !== undefined && snapshot.seedsByKey.has(definition.seedKey)).toBe(true)
            }
          }
        }

        // Ambient map coherence: every published entry answers to its key.
        for (const [name, schema] of snapshot.schemas) expect(schema.name).toBe(name)
      }),
      fuzzParams(60),
    )
  })

  it('resolution paths agree: winner uniqueness, round-trips, and kept-seed case model', () => {
    fc.assert(
      fc.property(universeArb, universe => {
        const snapshot = buildSnapshot(universe)
        const resolver = resolverFor(snapshot)
        const resolvedSchemas: ResolvedPropertySchema<unknown>[] = []

        // Winner uniqueness: within one effective-name group, only the head
        // may resolve by field id; every other member reports 'shadowed'
        // (propertySchemaResolution.ts:298-300).
        for (const [name, group] of snapshot.definitionsByName) {
          for (const [index, definition] of group.entries()) {
            const result = resolver.resolveField(definition.fieldId)
            if (index > 0) {
              expect(result).toEqual({status: 'identity-unavailable', reason: 'shadowed'})
              continue
            }
            if (result.status === 'resolved') {
              expect(result.schema.fieldId).toBe(definition.fieldId)
              expect(result.schema.name).toBe(name)
              expect(result.schema.workspaceId).toBe(WS)
              resolvedSchemas.push(result.schema)
            } else {
              // The winner itself can lack buildable behavior (metadata-only
              // row, propertySchemaResolution.ts:302-306).
              expect(result.reason).toBe('definition-unavailable')
            }
          }
        }

        // Kept-seed case model: unoccupied or own-provenance deterministic id
        // resolves (unshadowable, non-renamable); a foreign occupant
        // invalidates the declaration for this workspace
        // (propertySchemaResolution.ts:243-262 + registry pinning).
        for (const seed of snapshot.seedsByKey.values()) {
          const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
          const occupant = snapshot.definitionsByFieldId.get(fieldId)
          const result = resolver.resolve(seed as PropertyHandle<unknown>)
          if (occupant && occupant.seedKey !== seed.seedKey) {
            expect(result).toEqual({
              status: 'identity-unavailable',
              reason: 'definition-unavailable',
            })
          } else {
            expect(result.status).toBe('resolved')
            if (result.status === 'resolved') {
              expect(result.schema.fieldId).toBe(fieldId)
              expect(result.schema.name).toBe(seed.name)
              expect(result.schema.defaultValue).toEqual(seed.defaultValue)
              resolvedSchemas.push(result.schema)
            }
          }
        }

        // Dropped colliders must not resolve — they are not part of this
        // snapshot's identity space (propertyDefinitionRegistry.ts:55-63).
        for (const seed of universe.seeds) {
          if (snapshot.seedsByKey.has(seed.seedKey)) continue
          expect(resolver.resolve(seed as PropertyHandle<unknown>)).toEqual({
            status: 'identity-unavailable',
            reason: 'definition-unavailable',
          })
        }

        // Name-path agreement + full round-trip: each resolved schema is a
        // fixpoint of all three lookup paths.
        for (const schema of resolvedSchemas) {
          expect(resolver.resolveField(schema.fieldId)).toEqual({status: 'resolved', schema})
          expect(resolver.resolve(schema.name)).toEqual({status: 'resolved', schema})
        }

        // resolve(name) never resolves to a non-winner, and 'ambiguous' is
        // unreachable from a parse-shaped universe: kept seeds have unique
        // names, so no name ever synthesizes from two declarations
        // (propertySchemaResolution.ts:275-287).
        for (const name of NAMES) {
          const result = resolver.resolve(name)
          if (result.status === 'resolved') {
            const winner = snapshot.definitionsByName.get(result.schema.name)?.[0]
            if (winner) expect(result.schema.fieldId).toBe(winner.fieldId)
          } else {
            expect(result.reason).not.toBe('ambiguous')
          }
        }
      }),
      fuzzParams(60),
    )
  })

  it('the snapshot is insertion-order independent', () => {
    fc.assert(
      fc.property(
        universeArb.chain(universe =>
          fc.record({
            universe: fc.constant(universe),
            order: fc.shuffledSubarray(
              universe.rows.map((_, index) => index),
              {minLength: universe.rows.length, maxLength: universe.rows.length},
            ),
          }),
        ),
        ({universe, order}) => {
          const baseline = buildSnapshot(universe)
          const permuted = buildSnapshot(universe, order)
          const fingerprint = (snapshot: PropertyDefinitionRegistrySnapshot) => ({
            schemas: [...snapshot.schemas.entries()].sort(([a], [b]) => a.localeCompare(b)),
            definitionsByFieldId: [...snapshot.definitionsByFieldId.entries()].sort(([a], [b]) => a.localeCompare(b)),
            definitionsByName: [...snapshot.definitionsByName.entries()].sort(([a], [b]) => a.localeCompare(b)),
            schemasByFieldId: [...snapshot.schemasByFieldId.entries()].sort(([a], [b]) => a.localeCompare(b)),
            seedsByKey: [...snapshot.seedsByKey.entries()].sort(([a], [b]) => a.localeCompare(b)),
            seedsByName: [...snapshot.seedsByName.entries()].sort(([a], [b]) => a.localeCompare(b)),
          })
          expect(fingerprint(permuted)).toEqual(fingerprint(baseline))
        },
      ),
      fuzzParams(40),
    )
  })

  it('boundary resolution is total, fails closed on forged identities, and gates writes', () => {
    fc.assert(
      fc.property(universeArb, fc.boolean(), (universe, allowPlain) => {
        const snapshot = buildSnapshot(universe)
        const resolver = propertySchemaResolverForWorkspace(
          snapshot, WS, seedNameCounts(universe.seeds), allowPlain,
        )

        const resolvedPool: ResolvedPropertySchema<unknown>[] = []
        for (const seed of snapshot.seedsByKey.values()) {
          const result = resolver.resolve(seed as PropertyHandle<unknown>)
          if (result.status === 'resolved') resolvedPool.push(result.schema)
        }

        const probes: AnyPropertySchema[] = [
          ...universe.seeds,
          ...NAMES.map(plainSchemaFor),
          ...resolvedPool,
          // Forged identities: wrong workspace, wrong field id.
          ...resolvedPool.map(schema => ({...schema, workspaceId: OTHER_WS})),
          ...resolvedPool.map(schema => ({...schema, fieldId: 'forged-field-id'})),
        ]
        for (const probe of probes) {
          const result = resolver.resolveBoundary(probe)
          expect(result.status === 'available' || result.status === 'identity-unavailable').toBe(true)

          // Fail-closed on forged resolved identities
          // (propertySchemaResolution.ts:330-335 + resolveField miss).
          if ('workspaceId' in probe && (probe as ResolvedPropertySchema<unknown>).workspaceId === OTHER_WS) {
            expect(result).toEqual({
              status: 'identity-unavailable',
              reason: 'registry-not-workspace-keyed',
            })
          }
          if ('fieldId' in probe && (probe as ResolvedPropertySchema<unknown>).fieldId === 'forged-field-id') {
            expect(result.status).toBe('identity-unavailable')
          }

          // A plain schema whose name is claimed by any seed and that is not
          // this snapshot's selected ambient entry must not be writable
          // (propertySchemaResolution.ts:355-368).
          const isPlain = !('seedKey' in probe) && !('fieldId' in probe)
          if (
            isPlain &&
            snapshot.schemas.get(probe.name) !== probe &&
            (snapshot.seedsByName.has(probe.name) || (seedNameCounts(universe.seeds).get(probe.name) ?? 0) > 0)
          ) {
            expect(result.status).toBe('identity-unavailable')
          }

          // Write seam agrees with the boundary verdict
          // (propertySchemaResolution.ts:389-396).
          if (result.status === 'available') {
            expect(requireWritablePropertySchema(probe, resolver)).toBeDefined()
          } else {
            expect(() => requireWritablePropertySchema(probe, resolver))
              .toThrow(PropertySchemaIdentityError)
          }
        }
      }),
      fuzzParams(40),
    )
  })

  it('handle-trusting resolver: kernel identity, plugin decode fallback, strict write recovery', () => {
    fc.assert(
      fc.property(
        universeArb,
        fc.boolean(),
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant({nested: true})),
        (universe, allowPlain, junk) => {
          // No snapshot — the boot window / foreign-workspace resolver
          // (propertySchemaResolution.ts:125-187).
          const resolver = propertySchemaResolverForWorkspace(
            null, WS, seedNameCounts(universe.seeds), allowPlain,
          )

          for (const seed of universe.seeds) {
            const boundary = resolver.resolveBoundary(seed)
            expect(boundary.status).toBe('available')
            if (boundary.status !== 'available') continue
            if (seed.seedKey.startsWith('system:kernel-data/')) {
              // Kernel handles are unshadowable: trusted as-is, by identity
              // (propertySchemaResolution.ts:168-170).
              expect(boundary.schema).toBe(seed)
            } else {
              // Plugin handles read through a decode fallback: garbage the
              // strict codec rejects degrades to the default instead of
              // throwing in a synchronous render
              // (propertySchemaResolution.ts:104-123, 170-171).
              let strictRejects = false
              try {
                seed.codec.decode(junk)
              } catch {
                strictRejects = true
              }
              if (strictRejects) {
                expect(boundary.schema.codec.decode(junk)).toEqual(seed.defaultValue)
                // ...but the WRITE seam must recover the strict codec so an
                // undecodable stored value throws instead of being silently
                // replaced (propertySchemaResolution.ts:397-407).
                const writable = requireWritablePropertySchema(seed, resolver)
                expect(() => writable.codec.decode(junk)).toThrow()
              }
            }
            // Name/field lookups stay fail-closed without a snapshot
            // (propertySchemaResolution.ts:57-77).
            expect(resolver.resolve(seed.name).status).toBe('identity-unavailable')
          }

          // Plain schemas: any seed-claimed name fails closed; unclaimed
          // names are admitted only in the active-workspace boot window
          // (propertySchemaResolution.ts:173-186).
          const counts = seedNameCounts(universe.seeds)
          for (const name of NAMES) {
            const boundary = resolver.resolveBoundary(plainSchemaFor(name))
            const claims = counts.get(name) ?? 0
            if (claims > 1) {
              expect(boundary).toEqual({status: 'identity-unavailable', reason: 'ambiguous'})
            } else if (claims === 1) {
              expect(boundary).toEqual({status: 'identity-unavailable', reason: 'shadowed'})
            } else {
              expect(boundary.status).toBe(allowPlain ? 'available' : 'identity-unavailable')
            }
          }
        },
      ),
      fuzzParams(40),
    )
  })
})
