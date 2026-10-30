import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {annotationsDataExtension} from './dataExtension'
import {THREADS_IN_SCOPE_QUERY, type ScopeThread} from './scopeThreads'
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

const handleFor = (scopeId: string) => repo.query[THREADS_IN_SCOPE_QUERY]({workspaceId: WS, scopeId})
const byThread = (threads: readonly ScopeThread[] | undefined) =>
  Object.fromEntries((threads ?? []).map(t => [t.threadId, {open: t.open, path: t.path}]))

describe('annotations.threadsInScope', () => {
  it('lists the threads anchored in the scope, the root included, with each path up to it', async () => {
    const onRoot = await createThread(repo, {targetId: 'P', anchor: null, comment: 'on the scope root'})
    const deep = await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    const resolved = await createThread(repo, {targetId: 'B', anchor: null, comment: 'done'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    await createThread(repo, {targetId: 'Q', anchor: null, comment: 'outside'})
    // On a comment: it lives in its card, not in the outline.
    await createThread(repo, {targetId: deep.commentId!, anchor: null, comment: 'on a comment'})

    expect(byThread(await handleFor('P').load())).toEqual({
      [onRoot.threadId]: {open: true, path: []},
      [deep.threadId]: {open: true, path: ['A1', 'A']},
      [resolved.threadId]: {open: false, path: ['B']},
    })
  })

  it('follows new threads, resolution, moves, deletes and restores', async () => {
    const handle = handleFor('P')
    expect(await handle.load()).toEqual([])
    const unsubscribe = handle.subscribe(() => {})

    const deep = await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    await vi.waitFor(() => expect(byThread(handle.peek())).toEqual({[deep.threadId]: {open: true, path: ['A1', 'A']}}))
    await setThreadStatus(repo, deep.threadId, 'resolved')
    await vi.waitFor(() => expect(handle.peek()?.[0]?.open).toBe(false))

    await repo.tx(tx => tx.move('A', {parentId: 'Q', orderKey: 'a0'}), opts)
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    await repo.tx(tx => tx.move('Q', {parentId: 'B', orderKey: 'a0'}), opts)
    await vi.waitFor(() => expect(byThread(handle.peek())).toEqual({[deep.threadId]: {open: false, path: ['A1', 'A', 'Q', 'B']}}))

    await repo.tx(tx => tx.delete('Q'), opts)
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    await repo.tx(tx => tx.restore('Q'), opts)
    await vi.waitFor(() => expect(handle.peek()).toHaveLength(1))
    unsubscribe()
  })

  it('brings a thread back when its deleted target is restored', async () => {
    const deep = await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    const handle = handleFor('P')
    await handle.load()
    const unsubscribe = handle.subscribe(() => {})
    await repo.tx(tx => tx.delete('A1'), opts)
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    await repo.tx(tx => tx.restore('A1'), opts)
    await vi.waitFor(() => expect(byThread(handle.peek())).toEqual({[deep.threadId]: {open: true, path: ['A1', 'A']}}))
    unsubscribe()
  })

  it('does not re-resolve on a content edit along a path', async () => {
    await createThread(repo, {targetId: 'A1', anchor: null, comment: 'deep'})
    const handle = handleFor('P')
    await handle.load()
    const unsubscribe = handle.subscribe(() => {})
    const before = repo.handleStore.metrics.loaderInvalidations
    await repo.tx(tx => tx.update('A', {content: 'child a, edited'}), opts)
    expect(repo.handleStore.metrics.loaderInvalidations).toBe(before)
    // Liveness: a structural change on the same path still wakes it.
    await repo.tx(tx => tx.move('A', {parentId: 'Q', orderKey: 'a0'}), opts)
    await vi.waitFor(() => expect(handle.peek()).toEqual([]))
    unsubscribe()
  })
})
