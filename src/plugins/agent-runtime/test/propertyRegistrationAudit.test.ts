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

/** Rebuild the repo under test, optionally with a sync gate that says this
 *  device is behind. The audit refuses to report from an incomplete view, and
 *  the gate is the only injectable half of that predicate. */
const installRepo = (backfillSyncGate?: (cb: () => void) => () => void) => {
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    ...(backfillSyncGate ? {backfillSyncGate} : {}),
  }).repo
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(declaredProp, {source: 'test'}),
    typeSeedsFacet.of(thingType, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
}

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  installRepo()
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

  // NOTE: "a seeded definition is credited to its EFFECTIVE (registry-
  // normalized) name, not a drifted stored one" is NOT pinned, and I could
  // not construct it here. Staging the divergence needs a seed-backed row
  // whose stored name differs from the seed's declared name, and both routes
  // are closed in-harness: writing one through `repo.tx` is refused outright
  // (`SeededDefinitionWriteError`: "its bag is code-owned"), and a raw
  // `db.execute` write fires no reprojection, so the registry never
  // normalizes and the scenario evaporates. Seeds also don't materialize a
  // definition block in this harness at all. The guard is the
  // `definitionsByFieldId` lookup in `auditPropertyRegistration`; its
  // rationale is recorded there.

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

  it('counts a block once for provenance even if its bag repeats the key', async () => {
    // A raw write CAN store a duplicated key (JSON.stringify can't produce
    // one, and the `$.types` trigger sees a single row so nothing rejects
    // it). `json_each` then emits a row per occurrence — without a DISTINCT
    // one block could eat the whole per-key cap, repeat in `sampleBlockIds`
    // and inflate `sampledBlocks`, hiding the blocks that actually differ.
    await create({id: 'dup', properties: {types: ['demo-thing']}})
    await create({id: 'plain', properties: {types: ['demo-thing'], 'demo:dup': 'x'}})
    await repo.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      ['{"types":["demo-thing"],"demo:dup":1,"demo:dup":2}', 'dup'])

    // A cap of 2 is what discriminates: the raw ranking is dup, dup, plain,
    // so with a cap of 1 both versions return `dup` and the bug hides. With
    // 2, the un-deduplicated query spends BOTH slots on `dup` and never
    // surfaces `plain`.
    const audit = await auditPropertyRegistration(repo, WS, {blocksPerKey: 2})
    const entry = findEntry(audit, 'demo:dup')!

    expect(entry.sampleBlockIds).toEqual(['dup', 'plain'])
    expect(entry.types).toEqual([{type: 'demo-thing', sampledBlocks: 2}])
  })

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

  it('gives every key its own provenance budget — a high-volume key cannot starve a small one', async () => {
    // This is the whole point of the per-key ROW_NUMBER cap over a global
    // ORDER BY … LIMIT. Two keys are required to tell them apart: with one
    // key the two are indistinguishable, which is why every other cap test
    // here would pass against the starving version too.
    // 'demo:big' sorts before 'demo:small', so a global LIMIT spends its
    // whole budget on 'demo:big' and 'demo:small' comes back with nothing.
    await create({id: 'b1', properties: {types: ['demo-thing'], 'demo:big': 'x'}})
    await create({id: 'b2', properties: {types: ['demo-thing'], 'demo:big': 'x'}})
    await create({id: 'b3', properties: {types: ['demo-thing'], 'demo:big': 'x'}})
    await create({id: 'b4', properties: {types: ['demo-thing'], 'demo:small': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS, {blocksPerKey: 1})

    expect(findEntry(audit, 'demo:big')!.sampleBlockIds).toHaveLength(1)
    expect(findEntry(audit, 'demo:small')!.sampleBlockIds).toEqual(['b4'])
  })

  it('clamps a degenerate blocksPerKey instead of silently reporting every key as untyped', async () => {
    // `rn` starts at 1, so an unclamped 0 filters EVERY provenance row while
    // leaving `provenanceOmitted` unset — indistinguishable from "sampled,
    // and genuinely has no types".
    await create({id: 'b1', properties: {types: ['demo-thing'], 'demo:undeclared': 'x'}})

    const audit = await auditPropertyRegistration(repo, WS, {blocksPerKey: 0})
    const entry = findEntry(audit, 'demo:undeclared')!

    expect(entry.sampleBlockIds).toEqual(['b1'])
    expect(entry.types).toEqual([{type: 'demo-thing', sampledBlocks: 1}])
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

describe('audit-properties scan coverage', () => {
  // The report's job is to enumerate the keys a flip cannot carry, so a scan
  // over a partial `blocks` is worse than no scan: an under-count reads as
  // "nothing to fix" and is acted on.

  it('refuses to report while downloaded rows are still draining into blocks', async () => {
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})
    await sharedDb.db.execute(
      `INSERT INTO blocks_synced_changes (id, op) VALUES (?, 'upsert')`, ['not-yet-applied'])

    await expect(auditPropertyRegistration(repo, WS)).rejects.toThrow(/draining/i)
  })

  it('refuses to report while this device is behind the server', async () => {
    installRepo(() => () => {})
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})

    await expect(auditPropertyRegistration(repo, WS)).rejects.toThrow(/not caught up/i)
  })

  it('refuses a scan that starts behind even when the device catches up before it ends', async () => {
    // The mirror of the case below, and the reason the check is on BOTH
    // sides. A view that is incomplete at the start and complete at the end
    // leaves the histogram short by everything that landed after it ran,
    // while the closing read reports all clear.
    let behindSamples = 1
    installRepo(cb => {
      if (behindSamples > 0) behindSamples -= 1
      else cb()
      return () => {}
    })
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})
    behindSamples = 1

    await expect(auditPropertyRegistration(repo, WS)).rejects.toThrow(/Cannot audit/i)
  })

  it('discards a scan a drain started underneath, not only one that began behind', async () => {
    // The window a single up-front check leaves open: the view is complete
    // when the scan starts and not when it ends, so the histogram is short by
    // whatever landed in between while every later read looks settled.
    // Budget is reset after setup so this pins the audit's own samples
    // regardless of how many the repo consumed being built.
    let settlesLeft = 0
    installRepo(cb => {
      if (settlesLeft > 0) { settlesLeft -= 1; cb() }
      return () => {}
    })
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})
    settlesLeft = 1

    await expect(auditPropertyRegistration(repo, WS)).rejects.toThrow(/mid-scan/i)
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

  it('rejects an EMPTY --workspace instead of silently auditing the active one', async () => {
    // `--workspace "$UNSET"` expands to '' — the assertion exists to pin the
    // graph, so falling back would hand back a remediation list for a
    // workspace the caller never named.
    await create({id: 'b1', properties: {'demo:undeclared': 'x'}})

    await expect(executeCommand(
      {commandId: 'a-3', type: 'audit-properties', workspaceId: '   '},
      context,
    )).rejects.toThrow(/empty value/i)
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
