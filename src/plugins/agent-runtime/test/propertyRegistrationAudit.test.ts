// @vitest-environment happy-dom
//
// Workspace-wide "which property keys does the registry not know about"
// audit. `audit-extension` answers this per-extension and only for blocks
// carrying that extension's declared types; this answers it for the whole
// graph, which is where a key nobody owns shows up — and those are exactly
// the keys `materializePropertyChildrenForExistingRow` skips.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedProperty, seedType } from '@/data/api'
import type { BlockProperties } from '@/types.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { auditPropertyRegistration, describeUnregisteredProperty } from '../propertyRegistrationAudit'

const WS = 'ws-1'

const declaredProp = seedProperty({
  seedKey: 'test/property/declared',
  revision: 1,
  name: 'demo:declared',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const thingType = seedType({
  seedKey: 'test/type/thing',
  revision: 1,
  id: 'demo-thing',
  label: 'Thing',
  properties: [declaredProp],
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(declaredProp, {source: 'test'}),
    typeSeedsFacet.of(thingType, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false}))
})

const create = async (args: {id: string; properties?: BlockProperties}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.id,
      ...(args.properties ? {properties: args.properties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault})
}

const findEntry = (
  audit: Awaited<ReturnType<typeof auditPropertyRegistration>>,
  property: string,
) => audit.unregistered.find(entry => entry.property === property)

describe('auditPropertyRegistration', () => {
  it('reports a key nothing declares, with its cell count and the types of the blocks carrying it', async () => {
    await create({id: 'b1', properties: {types: ['demo-thing'], 'demo:undeclared': 'x'}})
    await create({id: 'b2', properties: {types: ['demo-thing'], 'demo:undeclared': 'y'}})

    const audit = await auditPropertyRegistration(repo, WS)
    const entry = findEntry(audit, 'demo:undeclared')

    expect(entry).toBeDefined()
    expect(entry!.cells).toBe(2)
    expect(entry!.reason).toBe('definition-unavailable')
    expect(entry!.definitionBlocks).toBe(0)
    expect(entry!.sampleBlockIds).toContain('b1')
    // Provenance: the types on those blocks are the only machine-readable
    // hint about which extension wrote the key.
    expect(entry!.types).toEqual([{type: 'demo-thing', blocks: 2}])
  })

  it('says nothing about a key a code seed declares', async () => {
    await create({id: 'b1', properties: {[declaredProp.name]: 'value'}})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(findEntry(audit, declaredProp.name)).toBeUndefined()
    expect(audit.registeredProperties).toBeGreaterThan(0)
  })

  it('ignores deleted blocks — their keys are not data the flip has to carry', async () => {
    await create({id: 'live', properties: {'demo:undeclared': 'x'}})
    await create({id: 'gone', properties: {'demo:undeclared': 'x'}})
    await repo.tx(async tx => { await tx.delete('gone') }, {scope: ChangeScope.BlockDefault})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(findEntry(audit, 'demo:undeclared')!.cells).toBe(1)
  })

  it('scopes to the requested workspace', async () => {
    await create({id: 'here', properties: {'demo:undeclared': 'x'}})
    await repo.tx(async tx => {
      await tx.create({
        id: 'elsewhere', workspaceId: 'ws-2', parentId: null, orderKey: 'k',
        content: 'elsewhere', properties: {'demo:foreign': 'x'},
      })
    }, {scope: ChangeScope.BlockDefault})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(findEntry(audit, 'demo:foreign')).toBeUndefined()
    expect(findEntry(audit, 'demo:undeclared')).toBeDefined()
  })

  it('refuses a workspace whose registry is not loaded rather than calling every key unregistered', async () => {
    // `propertySchemaResolverFor` fails CLOSED for a workspace that is
    // neither active nor previous: every name comes back
    // identity-unavailable. Auditing on that resolver would report the whole
    // graph as unregistered — a false clean-up list that reads authoritative.
    await repo.tx(async tx => {
      await tx.create({
        id: 'foreign', workspaceId: 'ws-unloaded', parentId: null, orderKey: 'k',
        content: 'foreign', properties: {[declaredProp.name]: 'v'},
      })
    }, {scope: ChangeScope.BlockDefault})

    await expect(auditPropertyRegistration(repo, 'ws-unloaded'))
      .rejects.toThrow(/registry/i)
  })

  it('totals cover every key, not just the unregistered ones', async () => {
    await create({id: 'b1', properties: {[declaredProp.name]: 'v', 'demo:undeclared': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(audit.distinctProperties).toBe(audit.registeredProperties + audit.unregistered.length)
    expect(audit.unregisteredCells).toBe(1)
    expect(audit.propertyCells).toBeGreaterThanOrEqual(2)
  })

  it('ranks by cell count so the biggest exposure reads first', async () => {
    // Names chosen so alphabetical order CONTRADICTS cell order: SQLite's
    // GROUP BY hands rows back sorted by key, which would make this pass
    // with no sort at all if `zzz` were the smaller key.
    await create({id: 'b1', properties: {'demo:aaa-one-cell': 'x', 'demo:zzz-two-cells': 'x'}})
    await create({id: 'b2', properties: {'demo:zzz-two-cells': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS)
    const names = audit.unregistered.map(entry => entry.property)
    expect(names.indexOf('demo:zzz-two-cells')).toBeLessThan(names.indexOf('demo:aaa-one-cell'))
  })
})

describe('describeUnregisteredProperty', () => {
  it('orders the fix for an undeclared key: enable the owner BEFORE synthesizing', () => {
    const {fix, blocksFlip} = describeUnregisteredProperty({
      property: 'demo:undeclared', reason: 'definition-unavailable', definitionBlocks: 0,
    })
    expect(blocksFlip).toBeUndefined()
    expect(fix).toMatch(/install.*enable/i)
    // The §9 collision hazard is the whole reason the order matters.
    expect(fix).toMatch(/synthes/i)
    expect(fix).toMatch(/collid|strand/i)
  })

  it('sends a broken definition block to repair, never to synthesis', () => {
    const {fix} = describeUnregisteredProperty({
      property: 'demo:broken', reason: 'definition-unavailable', definitionBlocks: 1,
    })
    expect(fix).toMatch(/repair/i)
    expect(fix).not.toMatch(/orphan synthesis/i)
  })

  it('tells a name collision to namespace one declaration', () => {
    const {fix} = describeUnregisteredProperty({
      property: 'title', reason: 'ambiguous', definitionBlocks: 0,
    })
    expect(fix).toMatch(/namespace/i)
  })

  it('calls the empty key a hard flip blocker', () => {
    const {fix, blocksFlip} = describeUnregisteredProperty({
      property: '', reason: 'definition-unavailable', definitionBlocks: 0,
    })
    expect(blocksFlip).toBe(true)
    expect(fix).toMatch(/flip blocker/i)
  })

  it('explains a shadowed definition without proposing a second one', () => {
    const {fix} = describeUnregisteredProperty({
      property: 'demo:shadowed', reason: 'shadowed', definitionBlocks: 2,
    })
    expect(fix).toMatch(/shadow|winner/i)
    expect(fix).not.toMatch(/orphan synthesis/i)
  })
})
