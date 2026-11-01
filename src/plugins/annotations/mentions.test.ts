// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension'
import {referencesDataExtension} from '@/plugins/references/dataExtension'
import {annotationsDataExtension} from './dataExtension'
import {captureAnchor} from './anchor'
import {MENTIONS_FOR_BLOCK_QUERY} from './mentionsQuery'
import {createThread} from './threads'
import {annotationTargetProp, THREAD_TYPE} from './schema'

const WS = 'ws'
const TARGET = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const opts = {scope: ChangeScope.BlockDefault}
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, newId: () => crypto.randomUUID(), extensions: [referencesDataExtension, backlinksDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes', properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: TARGET, workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'Target', properties: {[aliasesProp.name]: ['Target']}})
    await tx.create({id: OTHER, workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'See [[Target]]'})
    await tx.create({id: 'mention', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: `A **reason** ((${TARGET}))`})
  }, opts)
  await repo.awaitProcessors()
})

const mentions = (id = TARGET) => repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id}).load()

const crowdCards = async () => {
  await repo.tx(async tx => {
    for (let i = 0; i < 5; i++) await tx.create({id: `!early-${i}`, workspaceId: WS, parentId: 'page', orderKey: `b${i}`, content: `Source ((${TARGET}))`})
  }, opts)
  await repo.awaitProcessors()
  // Equal timestamps make the bounded order depend only on deterministic ids.
  await db.db.execute('UPDATE blocks SET created_at = 1 WHERE workspace_id = ?', [WS])
}

describe('margin mentions', () => {
  it('shows ordinary sources but excludes thread target edges and copied quotes', async () => {
    const {threadId} = await createThread(repo, {targetId: OTHER, anchor: captureAnchor('See [[Target]]', 0, 14)})
    await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    await repo.awaitProcessors()
    const raw = await repo.query['backlinks.forBlock']({workspaceId: WS, id: TARGET, rawSources: true}).load()
    expect(raw).toContain(threadId)
    expect((await mentions()).ids.sort()).toEqual([OTHER, 'mention'].sort())
  })

  it('excludes comments and nested replies in this target’s threads before the cap, but retains other threads’ comments', async () => {
    const {commentId} = await createThread(repo, {targetId: OTHER, anchor: null, comment: `Elsewhere ((${TARGET}))`})
    for (let i = 0; i < 4; i++) {
      const {commentId: local} = await createThread(repo, {targetId: TARGET, anchor: null, comment: `Already here ((${TARGET}))`})
      await repo.tx(tx => tx.create({id: `reply-${i}`, workspaceId: WS, parentId: local!, orderKey: 'a0', content: `Reply ((${TARGET}))`}), opts)
    }
    await repo.awaitProcessors()
    const answer = await mentions()
    expect(answer.total).toBe(3)
    expect(answer.ids.sort()).toEqual([OTHER, 'mention', commentId!].sort())
  })

  it('leaves a range reference on the thread’s Quoted in surface', async () => {
    const {threadId} = await createThread(repo, {targetId: TARGET, anchor: captureAnchor('Target', 0, 6)})
    await repo.tx(tx => tx.create({id: 'quoter', workspaceId: WS, parentId: 'page', orderKey: 'a3', content: `Quoted ((${threadId}))`}), opts)
    await repo.awaitProcessors()
    expect(await repo.query['backlinks.forBlock']({workspaceId: WS, id: threadId}).load()).toContain('quoter')
    expect((await mentions()).ids).not.toContain('quoter')
  })

  it('retains sources under an ordinary block carrying a target property', async () => {
    await repo.block('page').set(annotationTargetProp, TARGET)
    await repo.awaitProcessors()
    expect((await mentions()).ids).toContain('mention')
  })

  it('excludes a quote reply linked through a comment’s target rather than its physical parent', async () => {
    const outer = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Outer commentary'})
    const inner = await createThread(repo, {targetId: outer.commentId!, anchor: captureAnchor('Outer commentary', 0, 5), comment: `Nested ((${TARGET}))`})
    await repo.awaitProcessors()
    expect(await repo.query['backlinks.forBlock']({workspaceId: WS, id: TARGET}).load()).toContain(inner.commentId)
    expect((await mentions()).ids).not.toContain(inner.commentId)
    expect((await mentions()).total).toBe(2)
  })

  it('keeps the nearest thread’s ownership when its root is moved under another thread', async () => {
    const outer = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Outer'})
    const independent = await createThread(repo, {targetId: OTHER, anchor: null, comment: `Elsewhere ((${TARGET}))`})
    await repo.tx(tx => tx.move(independent.threadId, {parentId: outer.commentId!, orderKey: 'a0'}), opts)
    await repo.awaitProcessors()
    expect((await mentions()).ids).toContain(independent.commentId)
  })

  it('retains a mention in a thread whose target is missing', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'untargeted-thread', workspaceId: WS, parentId: 'page', orderKey: 'a3', properties: {[typesProp.name]: [THREAD_TYPE]}})
      await tx.move('mention', {parentId: 'untargeted-thread', orderKey: 'a0'})
    }, opts)
    expect((await mentions()).ids).toContain('mention')
  })

  it('terminates a cycle of threads targeting each other’s comments', async () => {
    const first = await createThread(repo, {targetId: OTHER, anchor: null, comment: `First ((${TARGET}))`})
    const second = await createThread(repo, {targetId: first.commentId!, anchor: null, comment: 'Second'})
    await repo.block(first.threadId).set(annotationTargetProp, second.commentId!)
    await repo.awaitProcessors()
    expect((await mentions()).ids).toContain(first.commentId)
  })

  it('caps cards at three and reports the remaining sources', async () => {
    await repo.tx(async tx => {
      for (let i = 0; i < 5; i++) await tx.create({id: `source-${i}`, workspaceId: WS, parentId: 'page', orderKey: `b${i}`, content: `Source ((${TARGET}))`})
    }, opts)
    await repo.awaitProcessors()
    const answer = await mentions()
    expect(answer.ids).toHaveLength(3)
    expect(answer.total - answer.ids.length).toBe(4)
    const sources = await repo.query['backlinks.forBlock']({workspaceId: WS, id: TARGET}).load()
    expect(answer.ids).toEqual(sources.slice(0, 3))
  })

  it('batches source and thread-root reads across a wave of target blocks', async () => {
    await repo.tx(tx => tx.update('mention', {content: `Both ((${TARGET})) and ((${OTHER}))`}), opts)
    await repo.awaitProcessors()
    const reads = vi.spyOn(db.db, 'getAll')
    try {
      const answers = await Promise.all([mentions(TARGET), mentions(OTHER)])
      expect(answers.every(answer => answer.ids.includes('mention'))).toBe(true)
      const sourceReads = reads.mock.calls.filter(([statement]) => statement.includes('SELECT DISTINCT br.target_id'))
      expect(sourceReads.filter(([statement]) => !statement.includes('br.source_field = ?'))).toHaveLength(1)
      expect(sourceReads.filter(([statement]) => statement.includes('br.source_field = ?'))).toHaveLength(1)
    } finally {
      reads.mockRestore()
    }
  })

  it('rechecks ancestry when a referencing comment moves into or out of a target thread', async () => {
    const {threadId} = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    const handle = repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET})
    const unsubscribe = handle.subscribe(() => {})
    expect((await handle.load()).ids).toContain('mention')
    await repo.tx(tx => tx.move('mention', {parentId: threadId, orderKey: 'a2'}), opts)
    await vi.waitFor(() => expect(handle.peek()?.ids).not.toContain('mention'))
    await repo.tx(tx => tx.move('mention', {parentId: 'page', orderKey: 'a2'}), opts)
    await vi.waitFor(() => expect(handle.peek()?.ids).toContain('mention'))
    unsubscribe()
  })

  it('recounts an unshown source moved into a target thread without walking its ancestry', async () => {
    const {threadId} = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    await repo.tx(async tx => {
      for (let i = 0; i < 5; i++) await tx.create({id: `early-${i}`, workspaceId: WS, parentId: 'page', orderKey: `b${i}`, content: `Source ((${TARGET}))`})
    }, opts)
    await repo.awaitProcessors()
    const handle = repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET})
    const unsubscribe = handle.subscribe(() => {})
    const before = await handle.load()
    const hidden = (await repo.query['backlinks.forBlock']({workspaceId: WS, id: TARGET}).load()).find(id => !before.ids.includes(id))!
    expect(hidden).toBeDefined()
    expect(before.total).toBe(7)
    await repo.tx(tx => tx.move(hidden, {parentId: threadId, orderKey: 'z0'}), opts)
    await vi.waitFor(() => expect(handle.peek()?.total).toBe(6))
    unsubscribe()
  })

  it('recounts an existing external thread retargeted onto a covered comment', async () => {
    const outer = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    const external = await createThread(repo, {targetId: OTHER, anchor: null, comment: `Elsewhere ((${TARGET}))`})
    await crowdCards()
    const handle = repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET})
    const unsubscribe = handle.subscribe(() => {})
    const before = await handle.load()
    expect(before.ids).not.toContain(external.commentId)
    expect(before.total).toBe(8)
    await repo.block(external.threadId).set(annotationTargetProp, outer.commentId!)
    await vi.waitFor(() => expect(handle.peek()?.total).toBe(7))
    unsubscribe()
  })

  it('recounts when an ordinary target-ref holder becomes a thread root', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'untyped-root', workspaceId: WS, parentId: 'page', orderKey: 'z0'})
      await tx.setProperty('untyped-root', annotationTargetProp, TARGET)
      await tx.move('mention', {parentId: 'untyped-root', orderKey: 'a0'})
    }, opts)
    await crowdCards()
    const handle = repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET})
    const unsubscribe = handle.subscribe(() => {})
    const before = await handle.load()
    expect(before.ids).not.toContain('mention')
    expect(before.total).toBe(7)
    await repo.block('untyped-root').set(typesProp, [THREAD_TYPE])
    await vi.waitFor(() => expect(handle.peek()?.total).toBe(6))
    unsubscribe()
  })

  it('retains sources under an untyped referrer of a covered comment', async () => {
    const outer = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    await repo.tx(async tx => {
      await tx.create({id: 'untyped-root', workspaceId: WS, parentId: 'page', orderKey: 'z0'})
      await tx.setProperty('untyped-root', annotationTargetProp, outer.commentId!)
      await tx.move('mention', {parentId: 'untyped-root', orderKey: 'a0'})
    }, opts)
    await repo.awaitProcessors()
    expect((await mentions()).ids).toContain('mention')
  })

  it('follows target edges rather than copied content links to a covered comment', async () => {
    const outer = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Discussion'})
    const text = `See [[Target]] and ((${outer.commentId}))`
    await repo.block(OTHER).setContent(text)
    const elsewhere = await createThread(repo, {targetId: OTHER, anchor: captureAnchor(text, 0, text.length), comment: `Elsewhere ((${TARGET}))`})
    await repo.awaitProcessors()
    expect((await mentions()).ids).toContain(elsewhere.commentId)
  })
})
