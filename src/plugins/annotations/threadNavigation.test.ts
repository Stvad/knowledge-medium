// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, type User} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {isCollapsedProp, peekFocusedBlockLocation, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {getLayoutSessionBlock, getUIStateBlock} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {__resetLayoutSessionIdForTesting} from '@/utils/layoutSessionId'
import {navigate} from '@/utils/navigation'
import {panelBlockIds} from '@/utils/panelLayoutProjection'
import {panelRenderScopeId, surfaceRenderScopeId} from '@/utils/renderScope'
import {captureAnchor} from './anchor'
import {annotationsPlugin} from './index'
import {annotationTargetProp} from './schema'
import {landingFocusScope} from './threadNavigation'
import {createThread, setThreadStatus} from './threads'
import {peekActiveThread} from './uiStore'

const WS = 'ws'
const USER: User = {id: 'alex', name: 'Alex'}
const B_TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER, extensions: [referencesDataExtension, annotationsPlugin]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Project notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
  }, opts)
})

const quoting = (text: string, quote: string) => {
  const from = text.indexOf(quote)
  return captureAnchor(text, from, from + quote.length)
}

const uiState = () => getUIStateBlock(repo, WS, USER, {})

const shownPanel = async () => {
  const rows = await (await getLayoutSessionBlock(await uiState(), repo.activeLayoutSessionId)).children.load()
  const [panel] = rows
  return {panelId: panel.id, blockIds: panelBlockIds(rows)}
}

/** Focus is per panel. */
const focused = async (panelId: string) => {
  const panel = repo.block(panelId)
  await panel.load()
  return peekFocusedBlockLocation(panel)
}

/** The scope of a card on `B`, shown inline (the margin isn't drawn here). */
const cardScope = (panelId: string, threadId: string, parent = panelRenderScopeId(panelId, 'B')) =>
  surfaceRenderScopeId('comments', parent, threadId)

describe('navigating into a thread', () => {
  it('a thread root lands on its target, with the card pinned and its root focused in it', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: quoting(B_TEXT, 'Thursday')})

    const result = await navigate(repo, {blockId: threadId, target: 'main'})

    const {panelId, blockIds} = await shownPanel()
    expect(result).toMatchObject({panelId, blockId: 'B'})
    expect(blockIds).toEqual(['B'])
    expect(peekActiveThread(panelId)).toBe(threadId)
    expect(await focused(panelId)).toEqual({blockId: threadId, renderScopeId: cardScope(panelId, threadId)})
  })

  it('a deep reply lands on the target, with that reply focused in the card', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Is it confirmed?'})
    const reply = await repo.mutate.createChild({parentId: commentId!, content: 'Yes, as of today.'})

    await navigate(repo, {blockId: reply, target: 'main'})

    const {panelId, blockIds} = await shownPanel()
    expect(blockIds).toEqual(['B'])
    expect(peekActiveThread(panelId)).toBe(threadId)
    expect(await focused(panelId)).toEqual({blockId: reply, renderScopeId: cardScope(panelId, threadId)})
  })

  it('a thread on a comment lands on the outer thread’s target, inside the comment’s card', async () => {
    const outer = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Thursday is tight.'})
    const inner = await createThread(repo, {
      targetId: outer.commentId!, anchor: quoting('Thursday is tight.', 'tight'), comment: 'How tight?',
    })

    await navigate(repo, {blockId: inner.commentId!, target: 'main'})

    const {panelId, blockIds} = await shownPanel()
    expect(blockIds).toEqual(['B'])
    expect(peekActiveThread(panelId)).toBe(outer.threadId)
    expect(await focused(panelId)).toEqual({
      blockId: inner.commentId,
      renderScopeId: cardScope(panelId, inner.threadId, cardScope(panelId, outer.threadId)),
    })
  })

  it('a resolved thread on a comment lands on that comment, which shows it as its own thread', async () => {
    const outer = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Thursday is tight.'})
    const inner = await createThread(repo, {
      targetId: outer.commentId!, anchor: quoting('Thursday is tight.', 'tight'), comment: 'How tight?',
    })
    await setThreadStatus(repo, inner.threadId, 'resolved')

    await navigate(repo, {blockId: inner.commentId!, target: 'main'})

    const {panelId, blockIds} = await shownPanel()
    expect(blockIds).toEqual([outer.commentId])
    expect(peekActiveThread(panelId)).toBe(inner.threadId)
    expect(await focused(panelId)).toEqual({
      blockId: inner.commentId,
      renderScopeId: cardScope(panelId, inner.threadId, panelRenderScopeId(panelId, outer.commentId!)),
    })
  })

  it('expands the collapsed comments a reply sits under', async () => {
    const {commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Is it confirmed?'})
    const reply = await repo.mutate.createChild({parentId: commentId!, content: 'Yes.'})
    const nested = await repo.mutate.createChild({parentId: reply, content: 'As of today.'})
    await repo.tx(async tx => {
      await tx.setProperty(commentId!, isCollapsedProp, true)
      await tx.setProperty(reply, isCollapsedProp, true)
    }, opts)

    await navigate(repo, {blockId: nested, target: 'main'})

    expect((await repo.load(commentId!))?.properties[isCollapsedProp.name]).toBeFalsy()
    expect((await repo.load(reply))?.properties[isCollapsedProp.name]).toBeFalsy()
  })

  it('stays on the thread when its target is deleted', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Hm.'})
    await repo.mutate.delete({id: 'B'})

    await navigate(repo, {blockId: threadId, target: 'main'})

    expect((await shownPanel()).blockIds).toEqual([threadId])
  })

  it('a resolved thread lands on its target too', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Done.'})
    await setThreadStatus(repo, threadId, 'resolved')

    await navigate(repo, {blockId: threadId, target: 'main'})

    const {panelId, blockIds} = await shownPanel()
    expect(blockIds).toEqual(['B'])
    expect(peekActiveThread(panelId)).toBe(threadId)
  })

  it('ends on a thread anchored, by hand, to a comment of itself', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Loop.'})
    await repo.tx(tx => tx.setProperty(threadId, annotationTargetProp, commentId!), opts)

    await navigate(repo, {blockId: threadId, target: 'main'})

    expect((await shownPanel()).blockIds).toEqual([commentId])
  })

  it('leaves other navigation alone', async () => {
    await navigate(repo, {blockId: 'page', target: 'main'})

    expect((await shownPanel()).blockIds).toEqual(['page'])
  })
})

describe('landingFocusScope', () => {
  it('puts the outermost card in the margin where the margin is drawn, and the cards inside it inline', () => {
    const landing = {targetId: 'B', threads: [{id: 'T1', open: true}, {id: 'T2', open: true}], collapsed: []}
    const margin = surfaceRenderScopeId('margin', panelRenderScopeId('p', 'B'), 'T1')

    expect(landingFocusScope('p', landing, true)).toBe(surfaceRenderScopeId('comments', margin, 'T2'))
  })
})
