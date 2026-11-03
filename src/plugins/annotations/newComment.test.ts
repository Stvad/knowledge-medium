// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, type User} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {exitEditModeForBlock, focusBlock, isEditingBlock, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {notifyBlockEditSettled} from '@/editor/editSettleSignal'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {deleteBlockThroughUi} from '@/utils/deleteBlockThroughUi'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension'
import {panelRenderScopeId} from '@/utils/renderScope'
import {captureAnchor} from './anchor'
import {annotationsPlugin} from './index'
import {startComment} from './newComment'
import {annotationTargetProp, THREAD_TYPE} from './schema'
import {cardRenderScopeId, peekActiveThread, setMarginShowing} from './uiStore'

/** Spied, so a test can tell the drop was never attempted: the deletion
 *  itself lands asynchronously after the check. */
vi.mock('@/utils/deleteBlockThroughUi.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/deleteBlockThroughUi.js')>()
  return {...actual, deleteBlockThroughUi: vi.fn(actual.deleteBlockThroughUi)}
})

const WS = 'ws'
const USER: User = {id: 'alex', name: 'Alex'}
const B_TEXT = 'We moved the launch to Thursday.'
const opts = {scope: ChangeScope.BlockDefault}
const SCOPE = panelRenderScopeId('panel', 'page')

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER, extensions: [referencesDataExtension, backlinksDataExtension, annotationsPlugin]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
  }, opts)
  vi.mocked(deleteBlockThroughUi).mockClear()
  setMarginShowing('panel', false)
})

const threadsOnB = () => repo.query['core.typedBlockIds']({
  workspaceId: WS, types: [THREAD_TYPE], referencedBy: {id: 'B', sourceField: annotationTargetProp.name},
}).load()

/** Start a comment on B and return its thread, its first comment and the
 *  card scope the comment is edited in. */
const start = async (anchor = captureAnchor(B_TEXT, B_TEXT.indexOf('Thursday'), B_TEXT.indexOf('Thursday') + 8)) => {
  expect(await startComment(repo, {targetId: 'B', anchor, renderScopeId: SCOPE})).toBe(true)
  const [threadId] = await threadsOnB()
  const [comment] = await repo.block(threadId).children.load()
  return {threadId, commentId: comment.id, scope: cardRenderScopeId('comments', SCOPE, threadId)}
}

const panel = () => repo.block('panel')

/** Edit mode leaves the comment and its editor unmounts, as Escape or a click
 *  elsewhere does. */
const leave = async (commentId: string, scope: string) => {
  await exitEditModeForBlock(panel(), commentId, scope)
  notifyBlockEditSettled(commentId)
}

/** Queued behind the check the leave started, so once it resolves the check
 *  has decided, and called the delete if it was going to. */
const settled = () => repo.tx(async () => {}, {...opts, description: 'fence'})

const dropAttempted = () => vi.mocked(deleteBlockThroughUi).mock.calls.length > 0

describe('starting a comment', () => {
  it('writes the thread with an empty first comment, edited in the thread’s card', async () => {
    const {threadId, commentId, scope} = await start()

    expect((await repo.load(commentId))?.content).toBe('')
    expect(isEditingBlock(panel(), commentId, scope)).toBe(true)
    expect(peekActiveThread('panel')).toBe(threadId)
  })

  it('takes the thread away again when its comment is left empty', async () => {
    const {threadId, commentId, scope} = await start()

    await leave(commentId, scope)

    await vi.waitFor(async () => expect((await repo.load(threadId))).toBeNull())
  })

  it('keeps it when the comment’s text is still on its way to the row', async () => {
    const {threadId, commentId, scope} = await start()

    // The editor flushes its debounced text as it unmounts, ahead of the
    // settled signal.
    void repo.tx(tx => tx.update(commentId, {content: 'Is this final?'}), opts)
    await leave(commentId, scope)
    await settled()

    expect(dropAttempted()).toBe(false)
    expect((await repo.load(threadId))).not.toBeNull()
    expect((await repo.load(commentId))?.content).toBe('Is this final?')
  })

  it('keeps watching while the comment is still being edited, as when its editor remounts', async () => {
    const {threadId, commentId, scope} = await start()

    notifyBlockEditSettled(commentId)
    await settled()
    expect(dropAttempted()).toBe(false)

    await leave(commentId, scope)
    await vi.waitFor(async () => expect((await repo.load(threadId))).toBeNull())
  })

  it('keeps it when the empty comment has a block nested under it', async () => {
    const {threadId, commentId, scope} = await start()
    await repo.mutate.createChild({parentId: commentId, content: 'Typed one level in'})

    await leave(commentId, scope)
    await settled()

    expect(dropAttempted()).toBe(false)
    expect((await repo.load(threadId))).not.toBeNull()
  })

  it('opens the comment in the margin\u2019s card where the margin is drawn', async () => {
    setMarginShowing('panel', true)
    expect(await startComment(repo, {targetId: 'B', anchor: null, renderScopeId: SCOPE})).toBe(true)
    const [threadId] = await threadsOnB()
    const [comment] = await repo.block(threadId).children.load()
    expect(isEditingBlock(panel(), comment.id, cardRenderScopeId('margin', SCOPE, threadId))).toBe(true)
  })

  it('takes the thread away when Backspace deletes its empty comment, focusing the root', async () => {
    const {threadId, commentId, scope} = await start()

    await repo.tx(tx => tx.delete(commentId), opts)
    await focusBlock(panel(), threadId, {edit: true, renderScopeId: scope})
    notifyBlockEditSettled(commentId)

    await vi.waitFor(async () => expect((await repo.load(threadId))).toBeNull())
  })

  it('follows a comment made by Enter, and takes the thread once it is left empty too', async () => {
    const {threadId, commentId, scope} = await start()
    const second = await repo.mutate.createChild({parentId: threadId, position: {kind: 'last'}})
    await enterEditModeForBlock(repo.block(second), panel(), scope, {start: 0})
    notifyBlockEditSettled(commentId)
    await settled()
    expect(dropAttempted()).toBe(false)

    await leave(second, scope)
    await vi.waitFor(async () => expect((await repo.load(threadId))).toBeNull())
  })

  it('keeps it when the empty comment has a property', async () => {
    const {commentId, scope} = await start()
    await repo.tx(tx => tx.update(commentId, {properties: {'test:mood': 'curious'}}), opts)

    await leave(commentId, scope)
    await settled()

    expect(dropAttempted()).toBe(false)
  })

  it('decides once: a comment emptied after it was first left keeps its thread', async () => {
    const {threadId, commentId, scope} = await start()
    await repo.tx(tx => tx.update(commentId, {content: 'Draft'}), opts)
    await leave(commentId, scope)
    await settled()

    await repo.tx(tx => tx.update(commentId, {content: ''}), opts)
    await leave(commentId, scope)
    await settled()

    expect(dropAttempted()).toBe(false)
    expect((await repo.load(threadId))).not.toBeNull()
  })
})
