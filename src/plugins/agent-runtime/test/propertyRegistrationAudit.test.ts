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
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'
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
let context: AgentRuntimeContext

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(declaredProp, {source: 'test'}),
    typeSeedsFacet.of(thingType, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
})

const create = async (args: {id: string; workspaceId?: string; properties?: BlockProperties}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
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
    expect(entry!.types).toEqual([{type: 'demo-thing', sampledBlocks: 2}])
  })

  it('says nothing about a key a code seed declares', async () => {
    await create({id: 'b1', properties: {[declaredProp.name]: 'value'}})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(findEntry(audit, declaredProp.name)).toBeUndefined()
    expect(audit.registeredProperties).toBeGreaterThan(0)
  })

  it('counts a definition block whose metadata does not parse, so the fix is repair and not a colliding second definition', async () => {
    // A live `property-schema` block with a decodable name but an invalid
    // change-scope: `parsePropertyDefinitionMetadata` returns null, so the
    // REGISTRY has no entry for it at all. Reading `definitionBlocks` from the
    // registry would say 0 → "nothing declares this name, synthesize one",
    // which would create the second definition that then collides.
    await create({id: 'defn', properties: {
      types: ['property-schema'],
      'property-schema:name': 'demo:broken',
      'property-schema:change-scope': 'not-a-real-scope',
    }})
    await create({id: 'user', properties: {'demo:broken': 'v'}})

    const audit = await auditPropertyRegistration(repo, WS)
    const entry = findEntry(audit, 'demo:broken')

    expect(entry).toBeDefined()
    expect(entry!.definitionBlocks).toBe(1)
    expect(entry!.fix).toMatch(/repair/i)
    expect(entry!.fix).not.toMatch(/orphan\s+synthesis/i)
  })

  // NOTE: the "resolver is captured before any await" property (so a live
  // workspace switch mid-audit can't void the classification) is NOT pinned
  // by a test. Intercepting it needs a spy on `repo.db`, which is the shared
  // test database, and every shape of that spy recursed. A flaky test in the
  // gate is worse than none; the invariant is a statement-order comment at
  // the capture site in `auditPropertyRegistration`.

  it('excludes a non-object properties_json instead of inventing a phantom empty key', async () => {
    // A corrupt scalar cell: `json_each('5')` yields one row whose key is
    // NULL, which would surface as property '' — reported as a hard flip
    // blocker that no one can act on. It must be counted as unreadable.
    await create({id: 'ok', properties: {'demo:undeclared': 'x'}})
    await create({id: 'corrupt'})
    await repo.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?', ['5', 'corrupt'])

    const audit = await auditPropertyRegistration(repo, WS)

    expect(findEntry(audit, '')).toBeUndefined()
    expect(audit.unreadableBlocks).toBe(1)
    expect(findEntry(audit, 'demo:undeclared')!.cells).toBe(1)
  })

  // NOTE: the MALFORMED-JSON half of the object guard is not pinned here,
  // and can't be: the `blocks` update triggers themselves run
  // `json_each(NEW.properties_json, '$.types')` (clientSchema.ts), which
  // raises on malformed JSON, so the write is rejected before it lands. Only
  // disk-level corruption (issue #284) can produce such a row, and that
  // bypasses the triggers. The guard is defence in depth for that case; the
  // VALID-but-non-object half above is reachable and is pinned.

  it('reports a genuine empty-string key as a flip blocker through the real audit', async () => {
    await create({id: 'ok', properties: {'demo:undeclared': 'x'}})
    await create({id: 'empty'})
    await repo.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?', ['{"":9}', 'empty'])

    const audit = await auditPropertyRegistration(repo, WS)
    const entry = findEntry(audit, '')

    expect(entry).toBeDefined()
    expect(entry!.blocksFlip).toBe(true)
    expect(entry!.fix).toMatch(/flip blocker/i)
    expect(audit.unreadableBlocks).toBe(0)
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
    await create({id: 'elsewhere', workspaceId: 'ws-2', properties: {'demo:foreign': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS)
    expect(findEntry(audit, 'demo:foreign')).toBeUndefined()
    expect(findEntry(audit, 'demo:undeclared')).toBeDefined()
  })

  it('refuses a workspace whose registry is not loaded rather than calling every key unregistered', async () => {
    // `propertySchemaResolverFor` fails CLOSED for a workspace that is
    // neither active nor previous: every name comes back
    // identity-unavailable. Auditing on that resolver would report the whole
    // graph as unregistered — a false clean-up list that reads authoritative.
    await create({id: 'foreign', workspaceId: 'ws-unloaded', properties: {[declaredProp.name]: 'v'}})

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

  it('marks keys past the provenance key cap instead of showing them as untyped', async () => {
    await create({id: 'b1', properties: {'demo:aaa-one': 'x', 'demo:bbb-two': 'x'}})
    await create({id: 'b2', properties: {'demo:bbb-two': 'x'}})

    // Cap of 1 key: the higher-cell key keeps provenance, the other is
    // explicitly flagged rather than silently reading as "no types".
    const audit = await auditPropertyRegistration(repo, WS, {keys: 1})

    expect(findEntry(audit, 'demo:bbb-two')!.provenanceOmitted).toBeUndefined()
    expect(findEntry(audit, 'demo:bbb-two')!.sampleBlockIds).toEqual(['b1', 'b2'])
    const omitted = findEntry(audit, 'demo:aaa-one')!
    expect(omitted.provenanceOmitted).toBe(true)
    // The cap drops DETAIL, never the count — an omitted key must not read
    // as a smaller problem than it is.
    expect(omitted.cells).toBe(1)
    expect(omitted.sampleBlockIds).toEqual([])
  })

  it('samples at most blocksPerKey blocks for provenance while keeping the exact cell count', async () => {
    await create({id: 'b1', properties: {types: ['demo-thing'], 'demo:wide': 'x'}})
    await create({id: 'b2', properties: {types: ['demo-thing'], 'demo:wide': 'x'}})
    await create({id: 'b3', properties: {types: ['demo-thing'], 'demo:wide': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS, {blocksPerKey: 2})
    const entry = findEntry(audit, 'demo:wide')!

    expect(entry.cells).toBe(3)
    // Type counts are over the SAMPLE, which is why the field says so.
    expect(entry.types).toEqual([{type: 'demo-thing', sampledBlocks: 2}])
  })
})

describe('audit-properties command', () => {
  it('runs through executeCommand and defaults to the active workspace', async () => {
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})

    const result = await executeCommand(
      {commandId: 'a-1', type: 'audit-properties'},
      context,
    ) as Awaited<ReturnType<typeof auditPropertyRegistration>>

    expect(result.workspaceId).toBe(WS)
    expect(result.unregistered.map(entry => entry.property)).toContain('demo:undeclared')
  })

  it('refuses an explicit workspace whose registry is not loaded', async () => {
    await expect(executeCommand(
      {commandId: 'a-2', type: 'audit-properties', workspaceId: 'ws-unloaded'},
      context,
    )).rejects.toThrow(/registry/i)
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

  it('checks the preset provider BEFORE telling anyone to edit a definition block', () => {
    // `tryBuildSchema` returns nothing for a preset whose plugin isn't loaded
    // ("preset's plugin may not be loaded", userSchemasService.ts) — the
    // definition is then perfectly valid, and editing it would destroy a
    // working preset config.
    const {fix} = describeUnregisteredProperty({
      property: 'demo:broken', reason: 'definition-unavailable', definitionBlocks: 1,
    })
    expect(fix).not.toMatch(/orphan\s+synthesis/i)
    expect(fix).toMatch(/repair/i)
    expect(fix.search(/enabl/i)).toBeLessThan(fix.search(/repair the block/i))
  })

  it('calls the empty key a hard flip blocker', () => {
    const {fix, blocksFlip} = describeUnregisteredProperty({
      property: '', reason: 'definition-unavailable', definitionBlocks: 0,
    })
    expect(blocksFlip).toBe(true)
    expect(fix).toMatch(/flip blocker/i)
  })

  // `ambiguous` and `shadowed` cannot come back from a NAME lookup, which is
  // the only call this module makes (see the function's own comment). These
  // pin that the enum is covered — defence in depth against a future resolver
  // change — and that neither branch pretends to be live guidance.
  it.each(['ambiguous', 'shadowed'] as const)(
    'labels the name-unreachable reason %s as such instead of as live guidance', reason => {
      const {fix} = describeUnregisteredProperty({
        property: 'demo:x', reason, definitionBlocks: 1,
      })
      expect(fix).toMatch(/unreachable/i)
    })
})
