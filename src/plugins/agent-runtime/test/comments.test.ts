// @vitest-environment happy-dom
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {COMMENT_THREAD_TYPE, type CommentsView} from '@knowledge-medium/agent-cli/protocol'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import {userPageBlockId} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {annotationsDataExtension} from '@/plugins/annotations/dataExtension'
import {THREAD_TYPE} from '@/plugins/annotations/schema'
import {setThreadStatus} from '@/plugins/annotations/threads'
import {attributionCreatorsProp} from '@/plugins/contributors/schema'
import {createAgentRuntimeContext, executeCommand} from '../commands'
import type {AgentRuntimeContext} from '../protocol'

const WS = 'ws'
const PAGE = '3f2a9c1d-0000-4000-8000-0000000000a1'
const BLOCK = 'b10c4e7a-0000-4000-8000-0000000000b1'
const TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let context: AgentRuntimeContext
let agentId: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const contextFor = (extensions = staticDataExtensions) => {
  const {repo} = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}})
  const runtime = resolveFacetRuntimeSync(extensions, {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  return createAgentRuntimeContext({repo, runtime, safeMode: false})
}

beforeEach(async () => {
  await resetTestDb(db.db)
  context = contextFor()
  await context.repo.tx(async tx => {
    await tx.create({id: PAGE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Launch plan',
      properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['Launch plan']}})
    await tx.create({id: BLOCK, workspaceId: WS, parentId: PAGE, orderKey: 'a0', content: TEXT})
  }, opts)
  await context.repo.awaitProcessors()
  agentId = (await run({type: 'create-contributor', name: 'Claude agent'}) as {id: string}).id
})

const run = (command: Record<string, unknown>) => executeCommand({commandId: 'test', ...command} as never, context)
const asAgent = (command: Record<string, unknown>) => run({...command, contributorId: agentId})
const comments = async (command: Record<string, unknown>) => await run({type: 'comments', ...command}) as CommentsView

describe('add-comment', () => {
  it('starts a thread on the quote, written as the agent, and returns its root', async () => {
    const created = await asAgent({type: 'add-comment', target: BLOCK, quote: 'Thursday', content: 'Is it confirmed?'}) as {
      threadId: string, commentId: string, quote: string,
    }
    expect(created).toMatchObject({quote: 'Thursday', quoteStart: TEXT.indexOf('Thursday')})
    expect((created as unknown as {excerpt: string}).excerpt).toBe(TEXT)
    const comment = await context.repo.load(created.commentId)
    expect(comment?.parentId).toBe(created.threadId)
    expect(comment?.properties[attributionCreatorsProp.name]).toEqual([agentId])
    // Listed with the agent's other writes.
    expect(JSON.stringify(await run({type: 'recent-changes', since: 0}))).toContain('agent runtime add-comment')
  })

  it('refuses an ambiguous quote without occurrence, and a missing one', async () => {
    await expect(asAgent({type: 'add-comment', target: BLOCK, quote: 'the'})).rejects.toThrow(/appears 2 times/)
    await expect(asAgent({type: 'add-comment', target: BLOCK, quote: 'Friday'})).rejects.toThrow(/not in the block/)
    expect((await comments({block: BLOCK})).total).toBe(0)
  })

  it('proposes an edit suggestion with a replacement, leaving the block as it is', async () => {
    const {threadId} = await asAgent({
      type: 'add-comment', target: BLOCK, quote: 'Thursday', replacement: 'Thursday 9am', content: 'Per the vendor.',
    }) as {threadId: string}
    expect((await context.repo.load(BLOCK))!.content).toBe(TEXT)
    expect((await comments({thread: threadId})).threads[0]).toMatchObject({
      status: 'open', anchor: 'exact', quote: 'Thursday', replacement: 'Thursday 9am',
    })
    await expect(asAgent({type: 'add-comment', target: BLOCK, replacement: 'x'})).rejects.toThrow(/replaces quoted text/)
  })

  it('takes a printed short id as its target', async () => {
    const created = await asAgent({type: 'add-comment', target: `^${BLOCK.slice(0, 8)}`, content: 'On the whole block'}) as {threadId: string}
    expect((await comments({thread: created.threadId})).threads[0]?.target?.id).toBe(BLOCK)
  })

  it('is refused while the Comments plugin is off', async () => {
    context = contextFor(staticDataExtensions.filter(extension => extension !== annotationsDataExtension))
    await expect(asAgent({type: 'add-comment', target: BLOCK, content: 'x'})).rejects.toThrow(/Enable the Comments plugin/)
    await expect(comments({block: BLOCK})).rejects.toThrow(/Enable the Comments plugin/)
  })
})

describe('comments', () => {
  it('names the thread type the dispatch daemon looks for', () => {
    expect(COMMENT_THREAD_TYPE).toBe(THREAD_TYPE)
  })


  it('returns each thread with its anchor, quote, target and nested comments with their authors', async () => {
    const {threadId, commentId} = await asAgent({type: 'add-comment', target: BLOCK, quote: 'Thursday', content: 'Is it confirmed?'}) as {
      threadId: string, commentId: string,
    }
    // A person's reply, written in the tab.
    const reply = await context.repo.mutate.createChild({parentId: commentId, content: 'Yes, 9am'})

    const view = await comments({scope: 'Launch plan'})
    expect(view.total).toBe(1)
    const [thread] = view.threads
    expect(thread).toMatchObject({
      id: threadId, status: 'open', anchor: 'exact', quote: 'Thursday', replacement: null,
      target: {id: BLOCK, deleted: false, path: ['Launch plan']},
    })
    expect(thread.target?.excerpt).toContain('Thursday')
    expect(thread.comments).toMatchObject([{
      id: commentId, content: 'Is it confirmed?', author: {id: agentId, name: 'Claude agent', kind: 'agent'},
      replies: [{id: reply, content: 'Yes, 9am', author: {id: userPageBlockId(WS, 'vlad'), kind: 'human'}, replies: []}],
    }])
  })

  it('never names the tab\'s user as the author of an agent\'s comment', async () => {
    const {commentId} = await asAgent({type: 'add-comment', target: BLOCK, content: 'From the agent'}) as {commentId: string}
    // The agent's profile page, left untitled.
    await context.repo.tx(tx => tx.update(agentId, {content: ''}), opts)
    const [comment] = (await comments({block: BLOCK})).threads[0].comments
    expect(comment).toMatchObject({id: commentId, author: {id: agentId, name: 'Contributor', kind: 'agent'}})
  })

  it('resolves the anchor against the target as it reads now', async () => {
    const {threadId} = await asAgent({type: 'add-comment', target: BLOCK, quote: 'Thursday'}) as {threadId: string}
    await context.repo.tx(tx => tx.update(BLOCK, {content: `Note: ${TEXT}`}), opts)
    expect((await comments({thread: threadId})).threads[0].anchor).toBe('moved')
    await context.repo.tx(tx => tx.update(BLOCK, {content: 'The launch is off.'}), opts)
    expect((await comments({thread: threadId})).threads[0].anchor).toBe('stale')
  })

  it('lists open threads unless closed ones are asked for, and pages them', async () => {
    const first = await asAgent({type: 'add-comment', target: BLOCK, content: 'one'}) as {threadId: string}
    await asAgent({type: 'add-comment', target: BLOCK, content: 'two'})
    await setThreadStatus(context.repo, first.threadId, 'resolved')

    expect((await comments({block: BLOCK})).total).toBe(1)
    const all = await comments({block: BLOCK, includeClosed: true, limit: 1})
    expect(all).toMatchObject({total: 2, offset: 0, nextOffset: 1})
    expect((await comments({thread: first.threadId})).threads[0].status).toBe('resolved')
  })

  it('caps the comments shown per thread, and says how many it left out', async () => {
    const {threadId} = await asAgent({type: 'add-comment', target: BLOCK, content: 'first'}) as {threadId: string}
    await context.repo.tx(async tx => {
      for (let i = 0; i < 55; i += 1) {
        await tx.create({workspaceId: WS, parentId: threadId, orderKey: `b${String(i).padStart(3, '0')}`, content: `reply ${i}`})
      }
    }, opts)
    const [thread] = (await comments({thread: threadId})).threads
    expect(thread.comments).toHaveLength(50)
    expect(thread.omittedComments).toBe(6)
  })

  it('ends a page early once it passes the views\' character budget', async () => {
    for (let i = 0; i < 8; i += 1) {
      await asAgent({type: 'add-comment', target: BLOCK, content: `${i} ${'x'.repeat(3_990)}`})
    }
    const page = await comments({block: BLOCK})
    expect(page.total).toBe(8)
    expect(page.threads.length).toBeLessThan(8)
    expect(page.nextOffset).toBe(page.threads.length)
    expect((await comments({block: BLOCK, offset: page.nextOffset!})).threads.length).toBeGreaterThan(0)
  })

  it('keeps a thread root moved under another thread\'s comment, and its comments, out of that thread', async () => {
    const outer = await asAgent({type: 'add-comment', target: BLOCK, content: 'Outer'}) as {threadId: string, commentId: string}
    const inner = await asAgent({type: 'add-comment', target: BLOCK, quote: 'Thursday', content: 'Inner'}) as {threadId: string, commentId: string}
    await context.repo.tx(tx => tx.move(inner.threadId, {parentId: outer.commentId, orderKey: 'z0'}), opts)

    const [outerThread] = (await comments({thread: outer.threadId})).threads
    expect(outerThread.comments).toMatchObject([{id: outer.commentId, replies: []}])
    const [innerThread] = (await comments({thread: inner.threadId})).threads
    expect(innerThread.comments).toMatchObject([{id: inner.commentId}])
  })

  it('takes exactly one of scope, block and thread, and refuses a thread id that is no thread', async () => {
    await expect(comments({})).rejects.toThrow(/exactly one/)
    await expect(comments({scope: PAGE, block: BLOCK})).rejects.toThrow(/exactly one/)
    await expect(comments({thread: BLOCK})).rejects.toThrow(/not a comment thread/)
  })
})
