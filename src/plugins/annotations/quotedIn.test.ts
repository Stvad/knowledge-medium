import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension.js'
import {BACKLINKS_COUNT_FOR_BLOCK_QUERY} from '@/plugins/backlinks/inline-counts/countQuery.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {deleteCommentFromCard} from './deleteComment'
import {annotationsPlugin} from './index'
import {pillCount, THREADS_FOR_BLOCK_QUERY} from './summaries'
import {createThread} from './threads'

const dialogs = vi.hoisted(() => ({answer: undefined as true | undefined, opened: [] as unknown[]}))
vi.mock('@/utils/dialogs.js', () => ({
  openDialog: (_component: unknown, props: unknown) => {
    dialogs.opened.push(props)
    return Promise.resolve(dialogs.answer)
  },
}))

const WS = 'ws'
const B_TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
let threadId: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  dialogs.answer = undefined
  dialogs.opened.length = 0
  await resetTestDb(db.db)
  // `((id))` parses as a reference only when `id` is UUID-shaped.
  repo = createTestRepo({
    db: db.db, user: {id: 'alex', name: 'Alex'}, newId: () => crypto.randomUUID(),
    extensions: [referencesDataExtension, backlinksDataExtension, annotationsPlugin],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Project notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
  }, opts)
  const from = B_TEXT.indexOf('Thursday')
  ;({threadId} = await createThread(repo, {targetId: 'B', anchor: captureAnchor(B_TEXT, from, from + 'Thursday'.length)}))
})

const quote = async (id = 'X') => {
  await repo.tx(tx => tx.create({
    id, workspaceId: WS, parentId: 'page', orderKey: `b-${id}`, content: `As planned, ((${threadId})) is fixed.`,
  }), opts)
  await repo.awaitProcessors()
}

const threadsOnB = () => repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()

describe('a quoted thread', () => {
  it('counts in its target’s comment pill once something quotes it', async () => {
    expect(pillCount(await threadsOnB())).toBe(0)

    await quote()

    await vi.waitFor(async () => expect(await threadsOnB()).toMatchObject([{id: threadId, quoterCount: 1}]))
    expect(pillCount(await threadsOnB())).toBe(1)
  })

  it('does not count the quoting block in its target’s reference pill', async () => {
    await quote()

    expect(await repo.query['backlinks.forBlock']({workspaceId: WS, id: threadId}).load()).toEqual(['X'])
    expect(await repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()).toBe(0)
  })
})

describe('deleting a quoted thread’s last comment from its card', () => {
  const lastComment = async () => {
    const commentId = await repo.mutate.createChild({parentId: threadId, content: 'Confirmed?'})
    return repo.block(commentId)
  }

  it('asks first, and deletes nothing when the answer is no', async () => {
    await quote()
    const comment = await lastComment()

    expect(await deleteCommentFromCard(comment)).toBe('refused')

    expect(dialogs.opened).toEqual([{count: 1}])
    expect((await repo.load(threadId))?.deleted).toBe(false)
    expect((await repo.load(comment.id))?.deleted).toBe(false)
  })

  it('leaves the quote as plain text once confirmed', async () => {
    await quote()
    const comment = await lastComment()
    dialogs.answer = true

    expect(await deleteCommentFromCard(comment)).toBe('deleted-thread')

    expect(await repo.load(threadId)).toBeNull()
    expect((await repo.load('X'))?.content).toBe('As planned, Thursday is fixed.')
  })

  it('does not ask about a thread nothing quotes', async () => {
    const comment = await lastComment()

    expect(await deleteCommentFromCard(comment)).toBe('deleted-thread')
    expect(dialogs.opened).toEqual([])
  })
})
