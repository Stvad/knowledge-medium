// @vitest-environment happy-dom
//
// Value-level grain checks. These are the half the source lint can't do:
// deciding whether a string is a block id needs a lookup, and deciding
// whether a JSON cell holds records needs the value. Both the write-time
// warning and `audit-extension` run through this rule set, so the tests
// exercise it directly plus once end-to-end through `update-block`.

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
import { auditExtensionData, writeWarnings } from '../grainAudit'

const WS = 'ws-1'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ABSENT_ID = '22222222-2222-4222-8222-222222222222'

const linkProp = seedProperty({
  seedKey: 'test/property/link',
  revision: 1,
  name: 'demo:link',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const refProp = seedProperty({
  seedKey: 'test/property/ref',
  revision: 1,
  name: 'demo:ref',
  preset: 'optional-ref',
  config: {targetTypes: ['demo-thing']},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const blobProp = seedProperty({
  seedKey: 'test/property/blob',
  revision: 1,
  name: 'demo:entries',
  preset: 'json',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const thingType = seedType({
  seedKey: 'test/type/thing',
  revision: 1,
  id: 'demo-thing',
  label: 'Thing',
  properties: [linkProp, refProp, blobProp],
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
    definitionSeedsFacet.of(linkProp, {source: 'test'}),
    definitionSeedsFacet.of(refProp, {source: 'test'}),
    definitionSeedsFacet.of(blobProp, {source: 'test'}),
    typeSeedsFacet.of(thingType, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  await create({id: TARGET_ID, content: 'Bench press'})
})

const create = async (args: {id: string; content?: string; properties?: BlockProperties}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? args.id,
      ...(args.properties ? {properties: args.properties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault})
}

describe('writeWarnings', () => {
  it('flags a property with no registered schema — the fingerprint of a write made while the extension is not running', async () => {
    const warnings = await writeWarnings(repo, {'demo:undeclared': 'whatever'})
    expect(warnings.map(w => w.rule)).toEqual(['unknown-property'])
    expect(warnings[0].message).toMatch(/stored raw/)
  })

  it('flags a live block id stored under a non-ref schema', async () => {
    const warnings = await writeWarnings(repo, {[linkProp.name]: TARGET_ID})
    expect(warnings.map(w => w.rule)).toEqual(['block-id-not-a-ref'])
    expect(warnings[0].property).toBe(linkProp.name)
  })

  it('says nothing when the pointer already uses a ref schema', async () => {
    expect(await writeWarnings(repo, {[refProp.name]: TARGET_ID})).toEqual([])
  })

  it('says nothing about a uuid that is not a block in this workspace', async () => {
    // External ids are often uuids. Only a value that RESOLVES is a missed ref.
    expect(await writeWarnings(repo, {[linkProp.name]: ABSENT_ID})).toEqual([])
  })

  it('flags records buried in a json cell, but leaves an opaque config object alone', async () => {
    const records = await writeWarnings(repo, {[blobProp.name]: [{weight: 135, reps: 8}, {weight: 135, reps: 7}]})
    expect(records.map(w => w.rule)).toEqual(['records-in-json-value'])
    expect(records[0].message).toMatch(/2 records/)

    expect(await writeWarnings(repo, {[blobProp.name]: {layout: 'grid'}})).toEqual([])
  })

  it('ignores kernel and app-owned bookkeeping properties', async () => {
    expect(await writeWarnings(repo, {
      types: ['demo-thing'],
      alias: ['Something'],
      'system:showProperties': false,
      'agent:subtreeKey': 'reply-1',
    })).toEqual([])
  })
})

describe('update-block', () => {
  it('returns the warnings alongside the block, without touching the block\'s own fields', async () => {
    await create({id: 'b1', content: 'entry'})
    const result = await executeCommand(
      {commandId: 'u-1', type: 'update-block', id: 'b1', properties: {[linkProp.name]: TARGET_ID}},
      context,
    ) as {id: string; properties: Record<string, unknown>; agentWarnings?: Array<{rule: string}>}

    expect(result.id).toBe('b1')
    expect(result.properties[linkProp.name]).toBe(TARGET_ID)
    expect(result.agentWarnings?.map(w => w.rule)).toEqual(['block-id-not-a-ref'])
  })

  it('stays quiet on a clean write', async () => {
    await create({id: 'b2', content: 'entry'})
    const result = await executeCommand(
      {commandId: 'u-2', type: 'update-block', id: 'b2', properties: {[refProp.name]: TARGET_ID}},
      context,
    ) as {agentWarnings?: unknown}
    expect(result.agentWarnings).toBeUndefined()
  })
})

describe('auditExtensionData', () => {
  it('audits the blocks carrying an extension\'s types and reports types nothing carries', async () => {
    await create({
      id: '33333333-3333-4333-8333-333333333333',
      content: 'Bench press — 135 × 8',
      properties: {types: ['demo-thing'], [linkProp.name]: TARGET_ID},
    })

    const audit = await auditExtensionData(repo, WS, ['demo-thing', 'demo-unused'])
    expect(audit.types).toEqual([{type: 'demo-thing', blocks: 1, truncated: false}])
    expect(audit.unusedTypes).toEqual(['demo-unused'])
    expect(audit.blocksScanned).toBe(1)
    expect(audit.warnings.map(w => [w.rule, w.blockId])).toEqual([
      ['block-id-not-a-ref', '33333333-3333-4333-8333-333333333333'],
    ])
  })

  it('reports when the scan limit truncated a large type', async () => {
    for (let i = 0; i < 3; i += 1) {
      await create({id: `many-${i}`, properties: {types: ['demo-thing']}})
    }
    const audit = await auditExtensionData(repo, WS, ['demo-thing'], 2)
    expect(audit.types).toEqual([{type: 'demo-thing', blocks: 3, truncated: true}])
    expect(audit.blocksScanned).toBe(2)
  })
})
