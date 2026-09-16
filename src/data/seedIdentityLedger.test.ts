// @vitest-environment happy-dom
//
// happy-dom because the tripwire resolves the REAL production extension set,
// and `staticAppExtensions` pulls component modules in with it — the same
// reason `staticAppExtensions.test.ts` runs there. The characterization tests
// below are environment-agnostic and share the file so the rule and the
// behaviour it exists for sit together.
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, definePresetCore, seedProperty, seedType} from '@/data/api'
import type {AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'
import {
  materializePropertySeeds,
  materializeTypeSeeds,
  propertyDefinitionBlockId,
} from '@/data/definitionSeeds'
import {definitionSeedsFacet, typeSeedsFacet, valuePresetCoresFacet} from '@/data/facets'
import {propertyNameProp, typesProp} from '@/data/properties'
import {
  describeHarvestConflicts,
  diffSeedLedger,
  frozenColumnNames,
  FROZEN_PROPERTY_SEEDS,
  FROZEN_TYPE_SEEDS,
  indexBySeedKey,
  RETIRED_PROPERTY_NAMES,
  RETIRED_TYPE_IDS,
  SEED_LEDGER_RULE,
  shippedPropertySeeds,
} from '@/data/seedIdentityLedger'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticAppExtensions} from '@/extensions/staticAppExtensions'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {discoverToggleTreeSync, type ToggleNode} from '@/facets/discoverToggleTree'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import type {Repo} from '@/data/repo'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

/** Every toggle id in the tree, forced ON. A plugin that ships disabled by
 *  default still ships its seeds, and a user who enabled it has values stored
 *  under them — so resolving at the defaults would leave exactly those seeds
 *  outside the ledger, silently. Vacuous today (the three default-off plugins
 *  declare none), which is why deleting this fails nothing: it is what stops
 *  the first one that does from opening that gap. */
const allTogglesOn = (nodes: readonly ToggleNode[], into = new Map<string, boolean>()) => {
  for (const node of nodes) {
    into.set(node.handle.id, true)
    allTogglesOn(node.children, into)
  }
  return into
}

/** The seeds a production build registers — the union of both static lists,
 *  because `staticDataExtensions` carries data extensions (agent-runtime,
 *  agent-dispatch-companion) that the app list's plugin entries do not pull in,
 *  and a seed missing from the union is a seed the ledger cannot see.
 *
 *  The lists DO overlap (plugins bundle their own data extension), and what
 *  makes the union safe is that `walkAppExtensionSync` dedupes by node
 *  reference — not that the lists are disjoint. A plugin that wrapped its data
 *  extension in a freshly built array would double-contribute every seed in it,
 *  which now surfaces as a duplicate-seedKey divergence rather than silently. */
const shippedSeeds = () => {
  const {repo} = createTestRepo({db: sharedDb.db})
  const tree = [...staticAppExtensions({repo}), ...staticDataExtensions]
  const runtime = resolveAppRuntimeSync(
    tree,
    {overrides: allTogglesOn(discoverToggleTreeSync(tree)), safeMode: false},
  )
  const types = runtime.read(typeSeedsFacet)
  const properties = shippedPropertySeeds(runtime.read(definitionSeedsFacet), types)
  return {properties: properties.seeds, conflicts: properties.conflicts, types}
}

describe('seed identity ledger', () => {
  it('ships exactly the property seeds the ledger freezes', () => {
    const shipped = indexBySeedKey(shippedSeeds().properties,
      seed => seed.seedKey, seed => [seed.name, seed.presetId, seed.codec.type])
    const frozen = indexBySeedKey(FROZEN_PROPERTY_SEEDS, row => row[0], row => [row[1], row[2], row[3]])
    expect(diffSeedLedger(
      'property', shipped.index, frozen.index, new Set(RETIRED_PROPERTY_NAMES),
      [...shipped.duplicates, ...frozen.duplicates],
    ), SEED_LEDGER_RULE).toEqual([])
  })

  it('ships exactly the type seeds the ledger freezes', () => {
    const shipped = indexBySeedKey(shippedSeeds().types, seed => seed.seedKey, seed => [seed.id])
    const frozen = indexBySeedKey(FROZEN_TYPE_SEEDS, row => row[0], row => [row[1]])
    expect(diffSeedLedger(
      'type', shipped.index, frozen.index, new Set(RETIRED_TYPE_IDS),
      [...shipped.duplicates, ...frozen.duplicates],
    ), SEED_LEDGER_RULE).toEqual([])
  })

  // Harvest RESOLVES a conflicting inline declaration by keeping the first and
  // dropping the rest, so the loser never appears in the inventory at all — and
  // becomes production's provider under any toggle profile that drops the
  // winner's type. The ledger has to see the ambiguity, not the resolution.
  // Vacuous over the production set today — 59 inline entries ARE full
  // declarations, but every one is the SAME OBJECT as its explicit
  // contribution, so harvest never has to choose. The mechanism is pinned by
  // the unit test below.
  it('ships no inline property declaration that harvest had to drop', () => {
    expect(describeHarvestConflicts(shippedSeeds().conflicts), SEED_LEDGER_RULE).toEqual([])
  })

  // A self-consistency check on the ledger DATA, which the two tripwires above
  // only catch while shipped and frozen agree. Per NAMESPACE, not merged: a
  // property name and a type id are independent storage keys — one lives in
  // `properties_json` keys, the other in `typesProp` values — so the same
  // spelling may legitimately be a live property and a retired type at once.
  // Driven off one table so a third kind cannot be added and forgotten.
  it.each([
    ['property', FROZEN_PROPERTY_SEEDS.map(row => row[1]), RETIRED_PROPERTY_NAMES],
    ['type', FROZEN_TYPE_SEEDS.map(row => row[1]), RETIRED_TYPE_IDS],
  ] as const)('retires no live %s key, and retires none twice', (_kind, live, retired) => {
    const liveKeys = new Set<string>(live)
    expect(retired.filter(key => liveKeys.has(key))).toEqual([])
    expect(retired).toHaveLength(new Set(retired).size)
    // Two rows on one storage key would make the owner lookup last-wins, and an
    // unchanged seed would be told it "takes over" the key from its own twin.
    expect(live).toHaveLength(liveKeys.size)
  })

  // A column frozen in the data but absent from the kind's field list is
  // compared by nothing — silently. Nothing in the type system links the two.
  it.each([
    ['property', FROZEN_PROPERTY_SEEDS as readonly (readonly string[])[]],
    ['type', FROZEN_TYPE_SEEDS as readonly (readonly string[])[]],
  ] as const)('compares every %s column the rows carry', (kind, rows) => {
    const expected = frozenColumnNames(kind).length + 1
    expect(rows.filter(row => row.length !== expected)).toEqual([])
  })
})

describe('diffSeedLedger', () => {
  const frozen = new Map([['k/property/a', ['a:name', 'string', 'string']]])
  const none = new Set<string>()

  it('reports a rename against the cells it strands, and where to retire the key', () => {
    expect(diffSeedLedger(
      'property', new Map([['k/property/a', ['a:renamed', 'string', 'string']]]), frozen, none,
    )).toEqual([
      'k/property/a: name "a:name" -> "a:renamed" — cells under "a:name" stop resolving ' +
        'and read as unset; revert, or accept the loss and add "a:name" to RETIRED_PROPERTY_NAMES',
    ])
  })

  // With the key unchanged nothing is abandoned, so a remedy offering "discard"
  // here ships the very crash the ledger exists to prevent.
  it('refuses to offer discard for an encoding change at an unchanged key', () => {
    const divergences = diffSeedLedger(
      'property', new Map([['k/property/a', ['a:name', 'number', 'number']]]), frozen, none,
    )
    expect(divergences).toHaveLength(2)
    for (const line of divergences) {
      expect(line).toContain('the key is UNCHANGED')
      // Not "throws": a widening decodes everything the old codec did.
      expect(line).toContain('decode it fine if the change only WIDENS')
      expect(line).toContain('revert')
    }
    expect(divergences[0]).toContain('codec "string" -> "number"')
    expect(divergences[1]).toContain('preset "string" -> "number"')
  })

  it('treats an encoding change as carried when the same row also renames', () => {
    const divergences = diffSeedLedger(
      'property', new Map([['k/property/a', ['a:renamed', 'number', 'number']]]), frozen, none,
    )
    expect(divergences.filter(line => line.includes('the old data is abandoned'))).toHaveLength(2)
    expect(divergences.some(line => line.includes('the key is UNCHANGED'))).toBe(false)
  })

  // The case `codec.type` alone cannot see: `optional-string` writes `null` for
  // unset and shares the `'string'` discriminator with its required twin, whose
  // decode throws on that null.
  it('reports an optional preset swapped for its required twin, which shares a codec type', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([['k/property/a', ['a:name', 'string', 'string']]]),
      new Map([['k/property/a', ['a:name', 'optional-string', 'string']]]),
      none,
    )
    expect(divergences).toHaveLength(1)
    expect(divergences[0]).toContain('preset "optional-string" -> "string"')
  })

  it('reports a seed the ledger has never frozen, with the line to add', () => {
    expect(diffSeedLedger(
      'property', new Map([['k/property/b', ['b:name', 'boolean', 'boolean']]]), new Map(), none,
    )).toEqual([
      'k/property/b: ships but the ledger does not freeze it — ' +
        'add ["k/property/b", "b:name", "boolean", "boolean"]',
    ])
  })

  // A removal loses nothing (the materialized row publishes itself), so it must
  // NOT borrow the rename cost — it leaves a key that only looks free.
  it('describes a removed seed as leaving its data live, not as losing it', () => {
    expect(diffSeedLedger('property', new Map(), frozen, none)).toEqual([
      'k/property/a: the ledger freezes it but nothing ships it — the materialized ' +
        'definition row keeps publishing "a:name" on its own, so its cells stay live — ' +
        'unless its preset core left with the same plugin, when they read as unset instead; ' +
        'delete the row and add "a:name" to RETIRED_PROPERTY_NAMES, or a later seed ' +
        'claiming "a:name" reads those values as its own',
    ])
  })

  it('describes a removed type seed by its own runtime behaviour', () => {
    expect(diffSeedLedger(
      'type', new Map(), new Map([['k/type/a', ['gone']]]), none,
    )).toEqual([
      'k/type/a: the ledger freezes it but nothing ships it — the materialized ' +
        'definition row is republished read-only under "gone", so tagged blocks keep ' +
        'resolving; delete the row and add "gone" to RETIRED_TYPE_IDS, or a later seed ' +
        'claiming "gone" reads those values as its own',
    ])
  })

  it('refuses a new seed that claims a retired property name', () => {
    expect(diffSeedLedger(
      'property',
      new Map([['k/property/b', ['a:retired', 'string', 'string']]]),
      new Map([['k/property/b', ['a:retired', 'string', 'string']]]),
      new Set(['a:retired']),
    )).toEqual([
      'k/property/b: claims "a:retired", a retired storage key — the data under it is ' +
        'still there and this seed would inherit it; pick a fresh key, or MIGRATE if ' +
        'adopting it is the intent',
    ])
  })

  // Same table, so a type-seed remedy cannot be left behind: its cost sentence
  // and its retired list are the type ones, not the property ones.
  it('names the type kind by its own field, cost and retired list', () => {
    expect(diffSeedLedger(
      'type', new Map([['k/type/a', ['renamed']]]), new Map([['k/type/a', ['original']]]), none,
    )).toEqual([
      'k/type/a: id "original" -> "renamed" — blocks tagged "original" silently lose the ' +
        'type; revert, or accept the loss and add "original" to RETIRED_TYPE_IDS',
    ])
  })

  it('refuses a new type seed that claims a retired type id', () => {
    expect(diffSeedLedger(
      'type',
      new Map([['k/type/b', ['gone']]]),
      new Map([['k/type/b', ['gone']]]),
      new Set(['gone']),
    ).map(line => line.split(' — ')[0])).toEqual(['k/type/b: claims "gone", a retired storage key'])
  })

  // Two seeds on one storage key is not a per-row fault, so checking rows one at
  // a time can never find it. Production tolerates both shapes — a colliding
  // property seed is DROPPED, a contested type id is winner-resolved — and in
  // both the outcome depends on which of them a profile loaded.
  it('refuses two shipped seeds that claim one storage key', () => {
    expect(diffSeedLedger(
      'property',
      new Map([
        ['k/property/b', ['a:name', 'string', 'string']],
        ['k/property/a', ['a:name', 'string', 'string']],
      ]),
      new Map([
        ['k/property/a', ['a:name', 'string', 'string']],
        ['k/property/b', ['a:name', 'string', 'string']],
      ]),
      none,
    )).toEqual([
      'k/property/a + k/property/b: all claim "a:name" — one storage key cannot have ' +
        'two owners — whichever of them a profile loads reads the same stored data ' +
        'under its own codec; namespace all but one',
    ])
  })

  it('refuses contending type ids too, which is what keeps the inventory complete', () => {
    expect(diffSeedLedger(
      'type',
      new Map([['k/type/a', ['shared']], ['k/type/b', ['shared']]]),
      new Map([['k/type/a', ['shared']], ['k/type/b', ['shared']]]),
      none,
    ).map(line => line.split(' — ')[0]))
      .toEqual(['k/type/a + k/type/b: all claim "shared"'])
  })

  // A key freed and reclaimed in ONE release has no tombstone yet, and the
  // rename remedy would have called its data lost while the successor reads it.
  it('reports a storage key handed from one seed to another in the same release', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([
        ['k/property/a', ['a:moved-on', 'string', 'string']],
        ['k/property/b', ['a:name', 'string', 'string']],
      ]),
      new Map([
        ['k/property/a', ['a:name', 'string', 'string']],
        ['k/property/b', ['b:name', 'string', 'string']],
      ]),
      none,
    )
    expect(divergences.map(line => line.split(' — ')[0])).toEqual([
      'k/property/a: name "a:name" -> "a:moved-on"',
      'k/property/b: name "b:name" -> "a:name"',
      'k/property/b: takes over "a:name" from k/property/a',
    ])
    // The vacating seed is told its data is picked up, not lost.
    expect(divergences[0]).toContain('k/property/b now claims "a:name", so that data is not lost')
    expect(divergences[0]).not.toContain('read as unset')
  })

  // While the prior owner still holds the key this is contention, not a
  // handover; saying "takes over" would be wrong.
  it('does not call it a handover while the prior owner still claims the key', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([
        ['k/property/a', ['a:name', 'string', 'string']],
        ['k/property/b', ['a:name', 'string', 'string']],
      ]),
      new Map([['k/property/a', ['a:name', 'string', 'string']]]),
      none,
    )
    expect(divergences.some(line => line.includes('takes over'))).toBe(false)
    expect(divergences.some(line => line.includes('all claim'))).toBe(true)
  })

  // Renaming a plugin edits every one of its seedKeys while nothing stored
  // moves. Reported as removal + arrival + handover that is three wrong answers,
  // and the retire advice among them names a key that is still shipped — which
  // the retired-key check would then refuse, leaving the ledger un-greenable.
  it('reports a vacated-and-reclaimed key as one line, not a removal plus an arrival', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([['system:places/property/lat', ['place:lat', 'number', 'number']]]),
      new Map([['system:geo/property/lat', ['place:lat', 'number', 'number']]]),
      none,
    )
    expect(divergences).toHaveLength(1)
    expect(divergences[0]).toContain(
      'system:geo/property/lat + system:places/property/lat: ' +
      'system:geo/property/lat is gone and system:places/property/lat arrives')
    expect(divergences[0]).not.toContain('RETIRED_PROPERTY_NAMES')
  })

  // The pair is indistinguishable from the declarations, so the line must carry
  // BOTH readings — inferring continuity would exempt a genuine reclaim from
  // the arrival, handover and removal checks that exist to catch it. For type
  // seeds the only frozen column is the id, so ANY removal-plus-addition on one
  // id lands here.
  it('refuses to pick between a refile and a reclaim, and says what each costs', () => {
    const divergences = diffSeedLedger(
      'type',
      new Map([['k/type/newcomer', ['widget']]]),
      new Map([['k/type/departed', ['widget']]]),
      none,
    )
    expect(divergences).toHaveLength(1)
    expect(divergences[0]).toContain('indistinguishable from here, so decide which it is')
    expect(divergences[0]).toContain('ONE seed refiled under a new seedKey')
    expect(divergences[0]).toContain(
      'DIFFERENT seeds: k/type/newcomer inherits what k/type/departed stored')
    expect(divergences[0]).toContain('MIGRATE deliberately')
  })

  it('does not read a move into rows that also changed a stored column', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([['system:places/property/lat', ['place:latitude', 'number', 'number']]]),
      new Map([['system:geo/property/lat', ['place:lat', 'number', 'number']]]),
      none,
    ).map(line => line.split(' — ')[0])
    expect(divergences).toEqual([
      'system:geo/property/lat: the ledger freezes it but nothing ships it',
      'system:places/property/lat: ships but the ledger does not freeze it',
    ])
  })

  // Both branches read one answer for "is the vacated key picked up?", so a
  // report cannot call the same cells abandoned in one line and read in another.
  it('tells the vacating seed and the successor the same story', () => {
    const divergences = diffSeedLedger(
      'property',
      new Map([['k/property/b', ['a:name', 'string', 'string']]]),
      new Map([
        ['k/property/a', ['a:name', 'string', 'string']],
        ['k/property/b', ['b:name', 'string', 'string']],
      ]),
      none,
    )
    const removal = divergences.find(line => line.startsWith('k/property/a'))!
    expect(removal).toContain('k/property/b already claims "a:name"')
    expect(removal).not.toContain('RETIRED_PROPERTY_NAMES')
  })

  it('is silent when every shipped seed matches', () => {
    expect(diffSeedLedger('property', new Map(frozen), frozen, none)).toEqual([])
  })
})

describe('indexBySeedKey', () => {
  const row = (key: string, name: string) => ({key, name})

  // Reported, not thrown: a throw would lose the rule, the remedy and every
  // other divergence, in a report whose whole design is one line each.
  it('reports a duplicate seed key rather than keeping the last row silently', () => {
    const {index, duplicates} = indexBySeedKey(
      [row('k/property/a', 'first'), row('k/property/a', 'second')], r => r.key, r => [r.name],
    )
    expect(duplicates).toEqual(['k/property/a'])
    expect(index.size).toBe(1)
  })

  it('indexes distinct keys and reports no duplicate', () => {
    const {index, duplicates} = indexBySeedKey(
      [row('k/property/a', 'a'), row('k/property/b', 'b')], r => r.key, r => [r.name],
    )
    expect([...index]).toEqual([['k/property/a', ['a']], ['k/property/b', ['b']]])
    expect(duplicates).toEqual([])
  })

  it('carries a duplicate through to the report as its own divergence', () => {
    expect(diffSeedLedger('property', new Map(), new Map(), new Set(), ['k/property/a']))
      .toEqual([
        'k/property/a: is declared more than once — production\'s own `indexSeeds` throws on ' +
          'this rather than choosing; drop one contribution so there is a single declaration ' +
          'to freeze',
      ])
  })
})

describe('shippedPropertySeeds', () => {
  const inlineOnly = seedProperty({
    seedKey: 'system:ledger-test/property/inline-only', revision: 1,
    name: 'ledgerTest:inlineOnly', preset: 'string', defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const owningType = seedType({
    seedKey: 'system:ledger-test/type/owner', revision: 1,
    id: 'ledgerTest:owner', label: 'Ledger test owner', properties: [inlineOnly],
  })

  // A property declared ONLY inside a type's `properties` still materializes a
  // backing block and stores user data (`harvestNestedPropertySeeds`). Reading
  // `definitionSeedsFacet` alone would leave exactly those outside the ledger.
  it('includes a property a type seed declares inline and nothing contributes', () => {
    expect(shippedPropertySeeds([], [owningType]).seeds.map(seed => seed.seedKey))
      .toEqual([inlineOnly.seedKey])
  })

  it('does not double-count a property both contributed and inlined', () => {
    expect(shippedPropertySeeds([inlineOnly], [owningType]).seeds.map(seed => seed.seedKey))
      .toEqual([inlineOnly.seedKey])
    expect(shippedPropertySeeds([inlineOnly], [owningType]).conflicts).toEqual([])
  })

  // Two types of the SAME owner inlining DIFFERENT declarations for one key.
  // Their type ids differ, so the contention check cannot see it, and harvest
  // returns only the winner — the loser is recoverable solely as a conflict.
  it('reports an inline declaration harvest dropped, which its return value cannot show', () => {
    const rival = seedProperty({
      seedKey: inlineOnly.seedKey, revision: 1,
      name: 'ledgerTest:rivalSpelling', preset: 'number', defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const rivalType = seedType({
      seedKey: 'system:ledger-test/type/rival', revision: 1,
      id: 'ledgerTest:rival', label: 'Ledger test rival', properties: [rival],
    })

    const {seeds, conflicts} = shippedPropertySeeds([], [owningType, rivalType])
    expect(seeds.map(seed => seed.name)).toEqual([inlineOnly.name])
    expect(conflicts).toEqual([
      {seedKey: inlineOnly.seedKey, typeSeedKey: rivalType.seedKey},
    ])
    expect(describeHarvestConflicts(conflicts)[0])
      .toContain('inlines a declaration for "system:ledger-test/property/inline-only"')
  })
})

/**
 * What the ledger exists to stop, driven through a real `cell` workspace — the
 * storage mode EVERY live workspace is in. Two releases of one seedKey: the
 * first writes a value through its declared handle, the second changes the
 * declaration and reads it back.
 *
 * These are characterization tests: they assert the damage, not a fix. Nothing
 * in the app repairs either case, so if one of them ever starts failing,
 * something grew a repair path and the ledger's rule #3 has an answer it did
 * not have before.
 */
describe('what a seed change does to values already stored', () => {
  const WS = 'ws-seed-identity'
  const RENAMED_KEY = 'system:ledger-test/property/nickname'
  const RETYPED_KEY = 'system:ledger-test/property/score'

  const before = seedProperty({
    seedKey: RENAMED_KEY, revision: 1, name: 'ledgerTest:nickname',
    preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
  })
  const afterRename = seedProperty({
    seedKey: RENAMED_KEY, revision: 2, name: 'ledgerTest:handle',
    preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
  })
  const beforeRetype = seedProperty({
    seedKey: RETYPED_KEY, revision: 1, name: 'ledgerTest:score',
    preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
  })
  const afterRetype = seedProperty({
    seedKey: RETYPED_KEY, revision: 2, name: 'ledgerTest:score',
    preset: 'number', defaultValue: 0, changeScope: ChangeScope.BlockDefault,
  })

  let released: Repo[] = []
  /** A seed pass left queued would fire during a later test with the database
   *  reset under it; unpin, THEN drain (definitionSeeds.test.ts's `releaseRepo`
   *  — draining a still-pinned pass parks on a membership wait). */
  const drain = async (): Promise<void> => {
    for (const repo of released) {
      repo.setActiveWorkspaceId(null)
      await repo.awaitSeedMaterialization()
    }
    released = []
  }
  afterEach(drain)

  /** One release: a Repo whose runtime declares exactly these seeds, with their
   *  definition blocks materialized the way bootstrap would.
   *
   *  Releases are SEQUENTIAL — the previous Repo is unpinned and drained before
   *  the next opens. Two live Repos over one database is not just untidy here:
   *  `createTestRepo` gives each its own `newId` / `newTxSeq` counters starting
   *  from the same value, so concurrent ones mint colliding ids. The prefixed
   *  `newId` makes that impossible rather than merely unlikely, and the drain
   *  keeps a queued seed pass from firing into the next release. */
  let releaseCount = 0
  const release = async (
    seeds: readonly AnyPropertySeedDeclaration[],
    types: readonly TypeSeedDeclaration[] = [],
    cores: readonly Parameters<typeof valuePresetCoresFacet.of>[0][] = [],
  ): Promise<Repo> => {
    await drain()
    releaseCount += 1
    const generation = releaseCount
    let minted = 0
    const {repo} = createTestRepo({
      db: sharedDb.db,
      newId: () => `r${generation}-${++minted}`,
      extensions: [[
        ...cores.map(core => valuePresetCoresFacet.of(core, {source: 'ledger-test'})),
        ...seeds.map(seed => definitionSeedsFacet.of(seed, {source: 'ledger-test'})),
        ...types.map(type => typeSeedsFacet.of(type, {source: 'ledger-test'})),
      ]],
    })
    released.push(repo)
    repo.setActiveWorkspaceId(WS)
    await repo.ensureSystemPages(WS)
    if (seeds.length > 0) await materializePropertySeeds(repo, WS, seeds)
    if (types.length > 0) await materializeTypeSeeds(repo, WS, types)
    return repo
  }

  /** Registry reads race the definition PROJECTORS, which deliver on a
   *  subscription tick after materialization rather than inside `release`. Poll
   *  the outcome instead of sleeping on it (AGENTS.md); a real regression still
   *  fails, it just takes the budget to say so. 2s stays strictly under the 5s
   *  default test timeout, which is the part that matters: an inner budget at or
   *  above the outer one could never report its own failure. */
  const settle = (assertion: () => void): Promise<void> =>
    vi.waitFor(assertion, {timeout: 2_000})

  const cellsOf = async (id: string): Promise<Record<string, unknown>> => {
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [id],
    )
    return JSON.parse(row.properties_json) as Record<string, unknown>
  }

  const withValue = async (
    seed: AnyPropertySeedDeclaration, id: string, value: string,
  ): Promise<void> => {
    const repo = await release([seed])
    await repo.tx(
      async tx => { await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''}) },
      {scope: ChangeScope.BlockDefault, description: 'seed-identity fixture'},
    )
    await repo.block(id).set(seed, value)
  }

  it('a rename reads as unset, leaving the old cell stranded beside the new one', async () => {
    await withValue(before, 'renamed-block', 'vlad')
    expect(await cellsOf('renamed-block')).toEqual({'ledgerTest:nickname': 'vlad'})

    const upgraded = await release([afterRename])
    const block = upgraded.block('renamed-block')
    await block.load()

    // Silent: the default, not a throw and not the stored value.
    expect(block.peekProperty(afterRename)).toBeUndefined()
    expect(block.get(afterRename)).toBe('')
    // The registry answers the DECLARED name, so the stored one resolves to
    // nothing — which is what `audit-properties` reports as unregistered. The
    // absence is asserted only once the presence has been seen, so it cannot
    // pass on an empty registry that simply had not loaded.
    await settle(() => {
      expect([...upgraded.propertyDefinitions!.schemas.keys()]).toContain('ledgerTest:handle')
    })
    expect([...upgraded.propertyDefinitions!.schemas.keys()])
      .not.toContain('ledgerTest:nickname')
    // And the backing definition block still stores the OLD name: seed
    // materialization creates and restores, it never repairs a payload.
    expect((await cellsOf(propertyDefinitionBlockId(WS, RENAMED_KEY)))[propertyNameProp.name])
      .toBe('ledgerTest:nickname')

    await upgraded.block('renamed-block').set(afterRename, 'vlad-again')
    expect(await cellsOf('renamed-block')).toEqual({
      'ledgerTest:nickname': 'vlad',
      'ledgerTest:handle': 'vlad-again',
    })
  })

  it('a codec change throws on read, out of whatever was rendering', async () => {
    await withValue(beforeRetype, 'retyped-block', 'seventeen')
    expect(await cellsOf('retyped-block')).toEqual({'ledgerTest:score': 'seventeen'})

    const upgraded = await release([afterRetype])
    const block = upgraded.block('retyped-block')
    await block.load()

    expect(() => block.get(afterRetype)).toThrow(/expected finite number/)
    expect(await cellsOf('retyped-block')).toEqual({'ledgerTest:score': 'seventeen'})
  })

  // Removal is the case that loses NOTHING, and the whole reason the retired
  // lists exist. The surviving seed keeps the property registry primed, which is
  // also the realistic shape: one plugin goes, the rest stay.
  const survivor = seedProperty({
    seedKey: 'system:ledger-test/property/survivor', revision: 1,
    name: 'ledgerTest:survivor', preset: 'string', defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  it('a removed property seed keeps publishing its name, so its cells stay live', async () => {
    await withValue(before, 'removed-block', 'vlad')

    const upgraded = await release([survivor])
    await settle(() => {
      // The surviving seed is what keeps the property registry primed at all;
      // assert that precondition rather than let a null registry read as a
      // missing name.
      expect(upgraded.propertyDefinitions, 'registry primed by the surviving seed').not.toBeNull()
      expect([...upgraded.propertyDefinitions!.schemas.keys()]).toContain('ledgerTest:nickname')
    })
    expect(upgraded.propertySchemaResolverFor(WS).resolve('ledgerTest:nickname').status)
      .toBe('resolved')
    expect(await cellsOf('removed-block')).toEqual({'ledgerTest:nickname': 'vlad'})
  })

  it('a removed type seed is republished read-only, so tagged blocks keep resolving', async () => {
    const owner = seedType({
      seedKey: 'system:ledger-test/type/widget', revision: 1,
      id: 'ledgerTest:widget', label: 'Ledger test widget',
    })
    const first = await release([], [owner])
    await first.tx(
      async tx => {
        await tx.create({
          id: 'tagged-block', workspaceId: WS, parentId: null, orderKey: 'a0', content: '',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed-identity fixture'},
    )
    await first.block('tagged-block').set(typesProp, [owner.id])

    const upgraded = await release([])
    await settle(() => { expect(upgraded.types.has(owner.id)).toBe(true) })
    expect(upgraded.types.get(owner.id)?.label).toBe(owner.label)
    expect(await cellsOf('tagged-block')).toEqual({types: [owner.id]})
  })

  // The condition on "a removal loses nothing": a property row publishes a
  // usable schema only while its preset core still resolves, and a runtime
  // install replaces `valuePresetCores` wholesale — so a PLUGIN-OWNED core
  // leaves with its plugin and the removal behaves like a rename instead. Seven
  // shipped seeds are in that position; the kernel-preset test above cannot see
  // it, which is what made the unconditional claim look verified.
  it('a removed seed whose PRESET also left reads as unset, not live', async () => {
    const pluginCodec = {
      type: 'ledgerTest:custom',
      encode: (value: string) => value,
      decode: (json: unknown) => String(json),
    }
    const pluginCore = definePresetCore<string>({
      id: 'ledgerTest:custom', build: () => pluginCodec, defaultValue: '',
    })
    const pluginSeed = seedProperty({
      seedKey: 'system:ledger-test/property/custom', revision: 1,
      name: 'ledgerTest:custom', preset: pluginCore, defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })

    const first = await release([pluginSeed], [], [pluginCore])
    await first.tx(
      async tx => {
        await tx.create({
          id: 'custom-block', workspaceId: WS, parentId: null, orderKey: 'a0', content: '',
        })
      },
      {scope: ChangeScope.BlockDefault, description: 'seed-identity fixture'},
    )
    await first.block('custom-block').set(pluginSeed, 'kept')

    // The survivor keeps the registry primed, so a missing name is the finding
    // rather than an unbuilt registry.
    const upgraded = await release([survivor])
    await settle(() => {
      expect([...upgraded.propertyDefinitions!.schemas.keys()]).toContain('ledgerTest:survivor')
    })
    expect([...upgraded.propertyDefinitions!.schemas.keys()]).not.toContain('ledgerTest:custom')
    expect(upgraded.propertySchemaResolverFor(WS).resolve('ledgerTest:custom').status)
      .toBe('identity-unavailable')
    // The cell is untouched either way — what changed is whether anything reads it.
    expect(await cellsOf('custom-block')).toEqual({'ledgerTest:custom': 'kept'})
  })

  // What the retired lists refuse, and why refusing is not pedantry: the
  // reclaiming seed brings its OWN default and still reads the previous seed's
  // stored value.
  it('a later seed claiming a freed name reads the previous seed\'s values', async () => {
    await withValue(before, 'reclaimed-block', 'vlad')
    const reclaimer = seedProperty({
      seedKey: 'system:ledger-test/property/nickname-v2', revision: 1,
      name: before.name, preset: 'string', defaultValue: 'ITS-OWN-DEFAULT',
      changeScope: ChangeScope.BlockDefault,
    })

    const upgraded = await release([reclaimer])
    const block = upgraded.block('reclaimed-block')
    await block.load()
    expect(block.get(reclaimer)).toBe('vlad')
  })
})
