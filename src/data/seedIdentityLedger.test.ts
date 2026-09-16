// @vitest-environment happy-dom
//
// happy-dom because the tripwire resolves the REAL production extension set,
// and `staticAppExtensions` pulls component modules in with it — the same
// reason `staticAppExtensions.test.ts` runs there. The characterization tests
// below are environment-agnostic and share the file so the rule and the
// behaviour it exists for sit together.
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, seedProperty, seedType} from '@/data/api'
import type {AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {materializePropertySeeds, propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {propertyNameProp} from '@/data/properties'
import {
  diffSeedLedger,
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

/** The seeds a production build registers. Both static lists, because they are
 *  not nested: `staticDataExtensions` carries data extensions (agent-runtime,
 *  agent-dispatch-companion) that the app list's plugin entries do not pull in,
 *  and a seed missing from this union is a seed the ledger cannot see. */
const shippedSeeds = () => {
  const {repo} = createTestRepo({db: sharedDb.db})
  const tree = [...staticAppExtensions({repo}), ...staticDataExtensions]
  const runtime = resolveAppRuntimeSync(
    tree,
    {overrides: allTogglesOn(discoverToggleTreeSync(tree)), safeMode: false},
  )
  const types = runtime.read(typeSeedsFacet)
  return {properties: shippedPropertySeeds(runtime.read(definitionSeedsFacet), types), types}
}

describe('seed identity ledger', () => {
  it('ships exactly the property seeds the ledger freezes', () => {
    const divergences = diffSeedLedger(
      'property',
      indexBySeedKey('shipped property', shippedSeeds().properties,
        seed => seed.seedKey, seed => [seed.name, seed.presetId, seed.codec.type]),
      indexBySeedKey('frozen property', FROZEN_PROPERTY_SEEDS,
        row => row[0], row => [row[1], row[2], row[3]]),
      new Set(RETIRED_PROPERTY_NAMES),
    )
    expect(divergences, SEED_LEDGER_RULE).toEqual([])
  })

  it('ships exactly the type seeds the ledger freezes', () => {
    const divergences = diffSeedLedger(
      'type',
      indexBySeedKey('shipped type', shippedSeeds().types, seed => seed.seedKey, seed => [seed.id]),
      indexBySeedKey('frozen type', FROZEN_TYPE_SEEDS, row => row[0], row => [row[1]]),
      new Set(RETIRED_TYPE_IDS),
    )
    expect(divergences, SEED_LEDGER_RULE).toEqual([])
  })
})

describe('diffSeedLedger', () => {
  const frozen = new Map([['k/property/a', ['a:name', 'string', 'string']]])
  const none = new Set<string>()

  it('reports a renamed seed against the field that moved', () => {
    expect(diffSeedLedger(
      'property', new Map([['k/property/a', ['a:renamed', 'string', 'string']]]), frozen, none,
    )).toEqual(['k/property/a: name "a:name" -> "a:renamed"'])
  })

  it('reports a re-encoded seed separately from a renamed one', () => {
    expect(diffSeedLedger(
      'property', new Map([['k/property/a', ['a:name', 'number', 'number']]]), frozen, none,
    )).toEqual([
      'k/property/a: codec "string" -> "number"',
      'k/property/a: preset "string" -> "number"',
    ])
  })

  // The case `codec.type` alone cannot see: `optional-string` writes `null` for
  // unset and shares the `'string'` discriminator with its required twin, whose
  // decode throws on that null.
  it('reports an optional preset swapped for its required twin, which shares a codec type', () => {
    expect(diffSeedLedger(
      'property',
      new Map([['k/property/a', ['a:name', 'string', 'string']]]),
      new Map([['k/property/a', ['a:name', 'optional-string', 'string']]]),
      none,
    )).toEqual(['k/property/a: preset "optional-string" -> "string"'])
  })

  it('reports a seed the ledger has never frozen, with the line to add', () => {
    expect(diffSeedLedger(
      'property', new Map([['k/property/b', ['b:name', 'boolean', 'boolean']]]), frozen, none,
    )).toEqual([
      'k/property/a: the ledger freezes it but nothing ships it — ' +
        'values stored under "a:name" are still there',
      'k/property/b: ships but the ledger does not freeze it — ' +
        'add ["k/property/b", "b:name", "boolean", "boolean"]',
    ])
  })

  it('reports a removed seed, whose stored values outlive its declaration', () => {
    expect(diffSeedLedger('property', new Map(), frozen, none)).toEqual([
      'k/property/a: the ledger freezes it but nothing ships it — ' +
        'values stored under "a:name" are still there',
    ])
  })

  it('refuses a new seed that claims a retired property name', () => {
    expect(diffSeedLedger(
      'property',
      new Map([['k/property/b', ['a:retired', 'string', 'string']]]),
      new Map([['k/property/b', ['a:retired', 'string', 'string']]]),
      new Set(['a:retired']),
    )).toEqual([
      'k/property/b: claims "a:retired", a retired key — values stored under it ' +
        'are still there and would be adopted under new semantics',
    ])
  })

  it('refuses a new type seed that claims a retired type id', () => {
    expect(diffSeedLedger(
      'type',
      new Map([['k/type/b', ['gone']]]),
      new Map([['k/type/b', ['gone']]]),
      new Set(['gone']),
    )).toEqual([
      'k/type/b: claims "gone", a retired key — values stored under it ' +
        'are still there and would be adopted under new semantics',
    ])
  })

  it('names the type kind by its own frozen field', () => {
    expect(diffSeedLedger(
      'type', new Map([['k/type/a', ['renamed']]]), new Map([['k/type/a', ['original']]]), none,
    )).toEqual(['k/type/a: id "original" -> "renamed"'])
  })

  it('is silent when every shipped seed matches', () => {
    expect(diffSeedLedger('property', new Map(frozen), frozen, none)).toEqual([])
  })
})

describe('indexBySeedKey', () => {
  const row = (key: string, name: string) => ({key, name})

  it('refuses a duplicate seed key rather than keeping the last row', () => {
    expect(() => indexBySeedKey(
      'shipped property', [row('k/property/a', 'first'), row('k/property/a', 'second')],
      r => r.key, r => [r.name],
    )).toThrow(/duplicate shipped property seed key "k\/property\/a"/)
  })

  it('indexes distinct keys', () => {
    expect([...indexBySeedKey(
      'frozen property', [row('k/property/a', 'a'), row('k/property/b', 'b')],
      r => r.key, r => [r.name],
    )]).toEqual([['k/property/a', ['a']], ['k/property/b', ['b']]])
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
    expect(shippedPropertySeeds([], [owningType]).map(seed => seed.seedKey))
      .toEqual([inlineOnly.seedKey])
  })

  it('does not double-count a property both contributed and inlined', () => {
    expect(shippedPropertySeeds([inlineOnly], [owningType]).map(seed => seed.seedKey))
      .toEqual([inlineOnly.seedKey])
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
  afterEach(async () => {
    // A seed pass left queued would fire during a later test with the database
    // reset under it; unpin, then drain (definitionSeeds.test.ts's `releaseRepo`).
    for (const repo of released) {
      repo.setActiveWorkspaceId(null)
      await repo.awaitSeedMaterialization()
    }
    released = []
  })

  /** One release: a Repo whose runtime declares exactly `seed`, with its
   *  definition block materialized the way bootstrap would. */
  const release = async (seed: AnyPropertySeedDeclaration): Promise<Repo> => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      extensions: [[definitionSeedsFacet.of(seed, {source: 'ledger-test'})]],
    })
    released.push(repo)
    repo.setActiveWorkspaceId(WS)
    await repo.ensureSystemPages(WS)
    await materializePropertySeeds(repo, WS, [seed])
    return repo
  }

  const cellsOf = async (id: string): Promise<Record<string, unknown>> => {
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [id],
    )
    return JSON.parse(row.properties_json) as Record<string, unknown>
  }

  const withValue = async (
    seed: AnyPropertySeedDeclaration, id: string, value: string,
  ): Promise<void> => {
    const repo = await release(seed)
    await repo.tx(
      async tx => { await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''}) },
      {scope: ChangeScope.BlockDefault, description: 'seed-identity fixture'},
    )
    await repo.block(id).set(seed, value)
  }

  it('a rename reads as unset, leaving the old cell stranded beside the new one', async () => {
    await withValue(before, 'renamed-block', 'vlad')
    expect(await cellsOf('renamed-block')).toEqual({'ledgerTest:nickname': 'vlad'})

    const upgraded = await release(afterRename)
    const block = upgraded.block('renamed-block')
    await block.load()

    // Silent: the default, not a throw and not the stored value.
    expect(block.peekProperty(afterRename)).toBeUndefined()
    expect(block.get(afterRename)).toBe('')
    // The registry answers the DECLARED name, so the stored one resolves to
    // nothing — which is what `audit-properties` reports as unregistered.
    expect([...upgraded.propertyDefinitions!.schemas.keys()])
      .toContain('ledgerTest:handle')
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

    const upgraded = await release(afterRetype)
    const block = upgraded.block('retyped-block')
    await block.load()

    expect(() => block.get(afterRetype)).toThrow(/expected finite number/)
    expect(await cellsOf('retyped-block')).toEqual({'ledgerTest:score': 'seventeen'})
  })
})
