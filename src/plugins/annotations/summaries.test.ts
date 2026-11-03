// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
import {KERNEL_FIELD_RECOGNITION_CHANNEL, KERNEL_FIELD_RECOGNITION_KEY} from '@/data/invalidation'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {highlightField, highlightRanges, threadHighlights} from './highlights'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {annotationTargetProp} from './schema'
import {countsInPill, drawsHighlight, pillCount, THREADS_FOR_BLOCK_QUERY} from './summaries'
import {createThread, replyTo, setThreadStatus} from './threads'

const WS = 'ws'
const TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content: TEXT}), opts)
})

const quoteAnchor = (quote: string) => {
  const from = TEXT.indexOf(quote)
  return captureAnchor(TEXT, from, from + quote.length)
}

const summariesOfB = () => repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()

describe('annotations.threadsForBlock', () => {
  it('summarises each thread, whole-block threads first and then by quote position', async () => {
    const vendor = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), comment: 'Which vendor?'})
    const highlight = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday')})
    const whole = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    await replyTo(repo, vendor.threadId)

    const summaries = await summariesOfB()
    expect(summaries.map(s => s.id)).toEqual([whole.threadId, highlight.threadId, vendor.threadId])
    expect(summaries.map(s => s.commentCount)).toEqual([1, 0, 2])
    expect(summaries.every(s => s.open)).toBe(true)
  })

  it('re-resolves when a thread is resolved or gains its first comment', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday')})
    const handle = repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})
    expect((await handle.load())[0]).toMatchObject({open: true, commentCount: 0})
    // Subscribed, as the pill and the editor are: a handle nobody watches is
    // not re-resolved on invalidation.
    const unsubscribe = handle.subscribe(() => {})

    await replyTo(repo, threadId)
    await vi.waitFor(() => expect(handle.peek()?.[0]?.commentCount).toBe(1))
    await setThreadStatus(repo, threadId, 'resolved')
    await vi.waitFor(() => expect(handle.peek()?.[0]?.open).toBe(false))
    unsubscribe()
  })

  it('stops counting a deleted comment', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    const replyId = await replyTo(repo, threadId)
    const handle = repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})
    expect((await handle.load())[0].commentCount).toBe(2)
    const unsubscribe = handle.subscribe(() => {})

    await repo.tx(tx => tx.delete(replyId), opts)
    await vi.waitFor(() => expect(handle.peek()?.[0]?.commentCount).toBe(1))
    unsubscribe()
  })

  it('depends on field recognition, which decides which children are properties', async () => {
    await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    const handle = repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})
    await handle.load()
    expect(handle.__depsForTest()).toContainEqual(
      {kind: 'plugin', channel: KERNEL_FIELD_RECOGNITION_CHANNEL, key: KERNEL_FIELD_RECOGNITION_KEY})
  })

  it('re-resolves when a thread is added to a block already showing its pill', async () => {
    const handle = repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})
    expect(await handle.load()).toEqual([])
    const unsubscribe = handle.subscribe(() => {})

    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    await vi.waitFor(() => expect(handle.peek()?.map(s => s.id)).toEqual([threadId]))
    unsubscribe()
  })
})

describe('annotations.threadsForBlock, batched over a render wave', () => {
  const statementsDuring = async <T>(run: () => Promise<T>): Promise<{result: T; statements: number}> => {
    const spies = (['getAll', 'getOptional', 'get'] as const).map(method => vi.spyOn(db.db, method))
    try {
      const result = await run()
      return {result, statements: spies.reduce((n, spy) => n + spy.mock.calls.length, 0)}
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  const loadWave = (ids: readonly string[]) =>
    statementsDuring(() => Promise.all(ids.map(id => repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id}).load())))

  it('drops a root deleted between reading the thread ids and reading the roots', async () => {
    const kept = await createThread(repo, {targetId: 'B', anchor: null, comment: 'kept'})
    const gone = await createThread(repo, {targetId: 'B', anchor: null, comment: 'gone'})
    await repo.awaitProcessors()
    const getAll = db.db.getAll.bind(db.db)
    let deleted = false
    const spy = vi.spyOn(db.db, 'getAll').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!deleted && sql.includes('km_comment_count')) {
        deleted = true
        // Lands between the two reads, as a sync-applied delete can; raw, so
        // nothing re-resolves the handle first.
        await db.db.writeTransaction(tx => tx.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [gone.threadId]))
      }
      return getAll(sql, params)
    })
    try {
      expect((await summariesOfB()).map(s => s.id)).toEqual([kept.threadId])
    } finally {
      spy.mockRestore()
    }
  })

  it('reads every block in a wave with as many statements as one block costs', async () => {
    const targets = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    await repo.tx(async tx => {
      for (const [i, id] of targets.entries()) {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: `b${i}`, content: TEXT})
      }
    }, opts)
    const threads = []
    for (const id of targets) threads.push(await createThread(repo, {targetId: id, anchor: null, comment: 'first'}))
    await replyTo(repo, threads[3].threadId)
    await repo.awaitProcessors()

    const one = await loadWave(['T0'])
    const many = await loadWave(targets.slice(1))
    expect(many.result.map(summaries => summaries.map(s => s.commentCount))).toEqual([[1], [1], [2], [1], [1], [1], [1]])
    expect(many.statements).toBe(one.statements)
  })

  it('counts comments only, not the property field rows of a workspace that stores properties as children', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'alex', 1, 1, 'none', NULL, 'children')`, [WS])
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), comment: 'Which vendor?'})
    await repo.awaitProcessors()
    const children = await db.db.getAll('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [threadId])
    expect(children.length).toBeGreaterThan(1)
    expect((await summariesOfB()).map(s => s.commentCount)).toEqual([1])
  })
})

describe('annotations.threadsForBlock, typed roots only', () => {
  it('ignores a plain block that merely carries an annotation:target', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'X', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Thursday'})
      await tx.setProperty('X', annotationTargetProp, 'B')
    }, opts)
    await repo.awaitProcessors()
    expect(await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()).toEqual(['X'])
    expect(await summariesOfB()).toEqual([])
  })
})

describe('visibility', () => {
  it('counts only open threads with comments in the pill, and highlights every open range thread', async () => {
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), comment: 'Which vendor?'})
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday')})
    const whole = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    const resolved = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('launch'), comment: 'Done'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')

    const summaries = await summariesOfB()
    expect(summaries.filter(countsInPill)).toHaveLength(2)
    const highlighted = summaries.filter(drawsHighlight)
    expect(highlighted).toHaveLength(2)
    expect(highlighted.map(s => s.id)).not.toContain(whole.threadId)
  })

  it('keeps a pill, unnumbered, on a block whose threads are all resolved or highlights, and counts an open suggestion', async () => {
    expect(pillCount(await summariesOfB())).toBeNull()
    const resolved = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('launch'), comment: 'Done'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday')})
    expect(pillCount(await summariesOfB())).toBe(0)
    await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    expect(pillCount(await summariesOfB())).toBe(1)
    // A suggestion waits on a decision, so it counts with no comment.
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), replacement: 'supplier'})
    expect(pillCount(await summariesOfB())).toBe(2)
  })
})

describe('edit-mode highlights', () => {
  let view: EditorView | null = null
  afterEach(() => { view?.destroy(); view = null })

  it('marks exact and moved quotes over the live doc, and drops stale and resolved ones', async () => {
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday'), comment: 'x'})
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), comment: 'y'})
    const resolved = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('launch'), comment: 'z'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    const summaries = await summariesOfB()

    expect(highlightRanges(TEXT, summaries)).toEqual([
      {from: 23, to: 31, moved: false, suggestion: false},
      {from: 44, to: 50, moved: false, suggestion: false},
    ])
    const edited = `Update: ${TEXT.replace('vendor', 'supplier')}`
    expect(highlightRanges(edited, summaries)).toEqual([{from: 31, to: 39, moved: true, suggestion: false}])
  })

  it('marks an edit suggestion\'s quote in its own style', async () => {
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday'), replacement: 'Thursday 9am'})
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('vendor'), comment: 'y'})
    const summaries = await summariesOfB()
    expect(summaries.map(thread => thread.suggestion)).toEqual([true, false])
    expect(highlightRanges(TEXT, summaries)).toEqual([
      {from: 23, to: 31, moved: false, suggestion: true},
      {from: 44, to: 50, moved: false, suggestion: false},
    ])

    view = new EditorView({
      state: EditorState.create({
        doc: TEXT,
        extensions: threadHighlights(repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})),
      }),
    })
    await vi.waitFor(() => expect(view!.dom.querySelectorAll('.km-annotation-highlight')).toHaveLength(2))
    expect([...view.dom.querySelectorAll('.km-annotation-highlight-suggestion')].map(mark => mark.textContent))
      .toEqual(['Thursday'])
  })

  it('follows the editor as the user types, from the threads the handle feeds it', async () => {
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday'), comment: 'x'})
    view = new EditorView({
      state: EditorState.create({
        doc: TEXT,
        extensions: threadHighlights(repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'})),
      }),
    })
    const marks = () => {
      const found: Array<[number, number]> = []
      view!.state.field(highlightField).decorations.between(0, view!.state.doc.length, (from, to) => { found.push([from, to]) })
      return found
    }
    await vi.waitFor(() => expect(marks()).toEqual([[23, 31]]))

    view.dispatch({changes: {from: 0, insert: 'Update: '}, selection: EditorSelection.single(0)})
    expect(marks()).toEqual([[31, 39]])
    expect(view.dom.querySelectorAll('.km-annotation-highlight-moved')).toHaveLength(1)
  })
})
