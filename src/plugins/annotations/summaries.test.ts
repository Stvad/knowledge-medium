// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
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

  it('keeps a pill, unnumbered, on a block whose threads are all resolved or highlights', async () => {
    expect(pillCount(await summariesOfB())).toBeNull()
    const resolved = await createThread(repo, {targetId: 'B', anchor: quoteAnchor('launch'), comment: 'Done'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    await createThread(repo, {targetId: 'B', anchor: quoteAnchor('Thursday')})
    expect(pillCount(await summariesOfB())).toBe(0)
    await createThread(repo, {targetId: 'B', anchor: null, comment: 'Overall'})
    expect(pillCount(await summariesOfB())).toBe(1)
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
      {from: 23, to: 31, moved: false},
      {from: 44, to: 50, moved: false},
    ])
    const edited = `Update: ${TEXT.replace('vendor', 'supplier')}`
    expect(highlightRanges(edited, summaries)).toEqual([{from: 31, to: 39, moved: true}])
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
