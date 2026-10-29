// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension.js'
import {BACKLINKS_COUNT_FOR_BLOCK_QUERY} from '@/plugins/backlinks/inline-counts/countQuery.js'
import {BACKLINKS_FOR_BLOCK_QUERY} from '@/plugins/backlinks/query.js'
import {groupedBacklinksDataExtension} from '@/plugins/grouped-backlinks/dataExtension.js'
import {GROUPED_BACKLINKS_FOR_BLOCK_QUERY} from '@/plugins/grouped-backlinks/query.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {createThread} from './threads'

const WS = 'ws'
const B = '3f2a9c1d-0000-4000-8000-0000000000b0'
const CLAUDE = '3f2a9c1d-0000-4000-8000-0000000000c1'
const B_TEXT = 'Ask [[claude]] whether Thursday holds'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

interface Graph {
  /** Mentions B in its own text. */
  mention: string
  /** A highlight on B whose quote contains `[[claude]]`. */
  highlight: string
  /** A comment on B whose own text mentions `[[claude]]`. */
  comment: string
}

let graph: Graph
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({
    db: db.db,
    user: {id: 'alex', name: 'Alex'},
    extensions: [referencesDataExtension, backlinksDataExtension, groupedBacklinksDataExtension, annotationsDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: CLAUDE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'claude',
      properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['claude']}})
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Project notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: B, workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
    await tx.create({id: 'mention', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: `see ((${B}))`})
  }, opts)
  await repo.awaitProcessors()

  const from = B_TEXT.indexOf('[[claude]]')
  const {threadId: highlight} = await createThread(repo, {
    targetId: B, anchor: captureAnchor(B_TEXT, from, from + '[[claude]] whether'.length),
  })
  const {commentId} = await createThread(repo, {
    targetId: B, anchor: null, comment: '[[claude]] can you check the vendor?',
  })
  await repo.awaitProcessors()
  graph = {mention: 'mention', highlight, comment: commentId!}
})

const exclude = {exclude: [{scope: 'self' as const, id: 'no-such-block'}]}

/** Each route, answering the set of backlink sources of `id`. */
const ROUTES: Record<string, (id: string) => Promise<readonly string[] | number>> = {
  'batch count': id => repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({workspaceId: WS, id}).load(),
  'batch list': id => repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id}).load(),
  'filtered forBlock': id => repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id, filter: exclude}).load(),
  'grouped': async id =>
    (await repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id}).load()).unfilteredSourceIds,
}

const expectSources = async (route: string, id: string, expected: string[]) => {
  const answer = await ROUTES[route](id)
  if (typeof answer === 'number') expect(answer).toBe(expected.length)
  else expect([...answer].sort()).toEqual([...expected].sort())
}

describe.each(Object.keys(ROUTES))('backlinks route: %s', route => {
  it('does not count a thread as a backlink of its target', async () => {
    // Both threads hold an annotation:target edge to B; only the mention counts.
    await expectSources(route, B, [graph.mention])
  })

  it('does not count a quoted page as mentioned by the thread, but counts a comment that mentions it', async () => {
    await expectSources(route, CLAUDE, [B, graph.comment])
  })
})

describe('raw sources', () => {
  it('still returns every edge, the excluded ones included', async () => {
    const raw = await repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: CLAUDE, rawSources: true}).load()
    expect(raw).toContain(graph.highlight)
  })
})

describe('the dispatch daemon’s mention sources', () => {
  // The daemon claims tasks from the bridge `backlinks` command, which runs
  // the unfiltered `backlinks.forBlock` (packages/agent-cli/src/graph.ts).
  it('get no task from a highlight quoting [[claude]], and one from a comment saying it', async () => {
    const sources = await repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: CLAUDE}).load()
    expect(sources).not.toContain(graph.highlight)
    expect(sources).toContain(graph.comment)
  })
})

describe('annotations.threadIdsForBlock', () => {
  it('answers the threads anchored to a block from the target edge alone', async () => {
    const threads = await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: B}).load()
    const commentThread = (await repo.load(graph.comment))!.parentId!
    expect([...threads].sort()).toEqual([graph.highlight, commentThread].sort())
    expect(await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: CLAUDE}).load()).toEqual([])
    expect(await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'mention'}).load()).toEqual([])
  })

  it('drops a deleted thread', async () => {
    await repo.tx(tx => tx.delete(graph.highlight), opts)
    const threads = await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: B}).load()
    expect(threads).not.toContain(graph.highlight)
    expect(threads).toHaveLength(1)
  })
})
