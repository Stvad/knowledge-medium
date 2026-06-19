// @vitest-environment jsdom
//
// Exercises the bridge's `backlinks` / `grouped-backlinks` / `data-model`
// commands end-to-end against a real Repo. The runtime is intentionally
// minimal — kernel + the backlinks/grouped-backlinks data extensions
// (which carry the queries AND the user-prefs infra the resolvers read).
// It deliberately omits the references *parse* processor: that processor
// re-derives references from content/properties post-commit, so manual
// `references` arrays would be asynchronously reconciled away. Trigger
// projection of `references_json` into `block_references` is part of the
// test DB schema, so the manual references here project deterministically.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'

const WS = 'ws-1'
const USER = {id: 'user-1', name: 'Alice'}
const TOPIC_A = '11111111-1111-4111-8111-111111111111'

interface BacklinkRef {
  id: string
  content: string
  types: string[]
  deepLink: string
  sourceFields: string[]
}
interface BacklinksResult {
  target: {id: string}
  total: number
  filter: unknown
  backlinks: BacklinkRef[]
}
interface GroupedResult {
  total: number
  grouping: Record<string, string[]>
  groups: Array<{
    label: string
    fallback: boolean
    deepLink: string | null
    members: Array<{id: string}>
  }>
}

let sharedDb: TestDb
let repo: Repo
let context: AgentRuntimeContext

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = new Repo({db: sharedDb.db, cache: new BlockCache(), user: USER})
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync(
    [kernelDataExtension, backlinksDataExtension, groupedBacklinksDataExtension],
    {repo, workspaceId: WS, safeMode: false},
  )
  repo.setFacetRuntime(runtime)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
})
afterEach(() => { repo.stopSyncObserver() })

const create = async (args: {
  id: string
  content?: string
  references?: BlockReference[]
}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? args.id,
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

describe('backlinks command', () => {
  it('hydrates sources and distinguishes wikilinks from property refs', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'src-a', content: 'Source A', references: [{id: 'target', alias: 'T'}]})
    await create({
      id: 'src-b',
      content: 'Source B',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })

    const out = await executeCommand(
      {commandId: 'bl-1', type: 'backlinks', id: 'target'},
      context,
    ) as BacklinksResult

    expect(out.target.id).toBe('target')
    expect(out.total).toBe(2)
    expect(out.filter).toBeNull()

    const byId = new Map(out.backlinks.map(ref => [ref.id, ref]))
    expect(byId.get('src-a')?.content).toBe('Source A')
    expect(byId.get('src-a')?.deepLink).toBe(`#${WS}/src-a`)
    expect(byId.get('src-a')?.sourceFields).toEqual([''])          // body wikilink
    expect(byId.get('src-b')?.sourceFields).toEqual(['reviewer'])  // projected property ref
  })

  it('an explicit object filter narrows the set', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'topic', content: 'Topic'})
    await create({
      id: 'src-a',
      references: [{id: 'target', alias: 'T'}, {id: 'topic', alias: 'Topic'}],
    })
    await create({id: 'src-b', references: [{id: 'target', alias: 'T'}]})

    const out = await executeCommand(
      {
        commandId: 'bl-filter',
        type: 'backlinks',
        id: 'target',
        filter: {include: [{referencedBy: {id: 'topic'}}]},
      },
      context,
    ) as BacklinksResult

    expect(out.backlinks.map(ref => ref.id)).toEqual(['src-a'])
    expect(out.total).toBe(1)
  })

  it("rejects a malformed filter spec", async () => {
    await create({id: 'target', content: 'Target'})
    await expect(executeCommand(
      {commandId: 'bl-bad', type: 'backlinks', id: 'target', filter: 'sideways'},
      context,
    )).rejects.toThrow(/filter must be/)
  })
})

describe('grouped-backlinks command', () => {
  it('groups by a shared ref and links the group page', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: TOPIC_A, content: 'Topic A'})
    await create({id: 'src-a1', references: [{id: 'target', alias: 'T'}, {id: TOPIC_A, alias: 'A'}]})
    await create({id: 'src-a2', references: [{id: 'target', alias: 'T'}, {id: TOPIC_A, alias: 'A'}]})
    await create({id: 'src-b', references: [{id: 'target', alias: 'T'}]})

    const out = await executeCommand(
      {commandId: 'gb-1', type: 'grouped-backlinks', id: 'target'},
      context,
    ) as GroupedResult

    expect(out.total).toBe(3)
    expect(out.groups.map(group => group.label)).toEqual(['Topic A', 'Other'])
    expect(out.groups[0].members.map(member => member.id).sort()).toEqual(['src-a1', 'src-a2'])
    expect(out.groups[0].deepLink).toBe(`#${WS}/${TOPIC_A}`)  // group is a real page → linkable
    expect(out.groups[1].fallback).toBe(true)
    expect(out.groups[1].deepLink).toBeNull()                 // the Other bucket isn't a block
  })

  it('grouping spec selects the config (user default vs none)', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'src', references: [{id: 'target', alias: 'T'}]})

    const def = await executeCommand(
      {commandId: 'gb-def', type: 'grouped-backlinks', id: 'target'},
      context,
    ) as GroupedResult
    // Default 'user' resolves the INITIAL user config (non-empty).
    expect(def.grouping.lowPriorityTags).toContain('person')

    const none = await executeCommand(
      {commandId: 'gb-none', type: 'grouped-backlinks', id: 'target', grouping: 'none'},
      context,
    ) as GroupedResult
    expect(none.grouping).toEqual({
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    })
  })
})

describe('data-model command', () => {
  it('returns the guide markdown', async () => {
    const guide = await executeCommand({commandId: 'dm-1', type: 'data-model'}, context)
    expect(typeof guide).toBe('string')
    expect(guide).toContain('block_references')
    expect(guide).toContain('grouped-backlinks')
    expect(guide).toContain('source_field')
  })
})
