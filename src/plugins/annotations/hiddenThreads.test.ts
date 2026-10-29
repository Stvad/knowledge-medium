import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {annotationsDataExtension} from './dataExtension'
import {OPEN_THREADS_UNDER_QUERY} from './hiddenThreads'
import {createThread, setThreadStatus} from './threads'

const WS = 'ws'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  // P ─ A ─ A1
  //   └ B
  // Q
  await repo.tx(async tx => {
    await tx.create({id: 'P', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'parent'})
    await tx.create({id: 'A', workspaceId: WS, parentId: 'P', orderKey: 'a0', content: 'child a'})
    await tx.create({id: 'A1', workspaceId: WS, parentId: 'A', orderKey: 'a0', content: 'grandchild'})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'P', orderKey: 'a1', content: 'child b'})
    await tx.create({id: 'Q', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'elsewhere'})
  }, opts)
})

const handleUnder = (id: string) => repo.query[OPEN_THREADS_UNDER_QUERY]({workspaceId: WS, id})

describe('annotations.openThreadsUnder', () => {
  it('lists the open threads anchored anywhere below a block, not on it', async () => {
    await createThread(repo, {targetId: 'P', anchor: null, comment: 'on the parent itself'})
    const onGrandchild = await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    const onChild = await createThread(repo, {targetId: 'B', anchor: null})
    const resolved = await createThread(repo, {targetId: 'A', anchor: null, comment: 'done'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    await createThread(repo, {targetId: 'Q', anchor: null, comment: 'unrelated'})

    expect(new Set(await handleUnder('P').load())).toEqual(new Set([onGrandchild.threadId, onChild.threadId]))
    expect(await handleUnder('A1').load()).toEqual([])
  })

  it('follows new threads, resolution and blocks moving in or out', async () => {
    const handle = handleUnder('P')
    expect(await handle.load()).toEqual([])
    const unsubscribe = handle.subscribe(() => {})

    const deep = await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    await vi.waitFor(() => expect(handle.peek()).toEqual([deep.threadId]))
    await setThreadStatus(repo, deep.threadId, 'resolved')
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    await setThreadStatus(repo, deep.threadId, 'open')
    await vi.waitFor(() => expect(handle.peek()).toEqual([deep.threadId]))

    await repo.tx(tx => tx.move('A', {parentId: 'Q', orderKey: 'a0'}), opts)
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    const onQ = await createThread(repo, {targetId: 'Q', anchor: null, comment: 'q'})
    await repo.tx(tx => tx.move('Q', {parentId: 'B', orderKey: 'a0'}), opts)
    await vi.waitFor(() => expect(new Set(handle.peek())).toEqual(new Set([deep.threadId, onQ.threadId])))
    unsubscribe()
  })
})
