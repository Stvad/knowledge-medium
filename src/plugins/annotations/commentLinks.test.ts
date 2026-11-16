// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, type User} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {isCollapsedProp, peekFocusedBlockLocation, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {getLayoutSessionBlock, getUIStateBlock} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, childrenOf} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {__resetLayoutSessionIdForTesting} from '@/utils/layoutSessionId'
import {navigate, type NavigatePanelInput} from '@/utils/navigation'
import {panelBlockIds} from '@/utils/panelLayoutProjection'
import {panelRenderScopeId} from '@/utils/renderScope'
import {goToComment} from './commentLinks'
import {contributorsDataExtension} from '@/plugins/contributors/dataExtension'
import {attributionCreatorsProp} from '@/plugins/contributors/schema'
import {annotationsPlugin} from './index'
import {COMMENT_LINKS_FOR_BLOCK_QUERY} from './queries'
import {createThread, moveToOwnThread, setThreadStatus} from './threads'
import {cardRenderScopeId} from './uiStore'

const WS = 'ws'
const USER: User = {id: 'alex', name: 'Alex'}
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

/** page › section (collapsed) › point; elsewhere is another page. */
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER, extensions: [referencesDataExtension, contributorsDataExtension, annotationsPlugin]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Draft',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'section', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'Section',
      properties: {[isCollapsedProp.name]: true}})
    await tx.create({id: 'point', workspaceId: WS, parentId: 'section', orderKey: 'a0', content: 'A point'})
    await tx.create({id: 'elsewhere', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Elsewhere',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
  }, opts)
})

const shownPanel = async () => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const [panel] = await childrenOf(repo, (await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)).id)
  return panel.id
}

const shownBlocks = async () => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  return panelBlockIds(await childrenOf(repo, (await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)).id))
}

/** The page open in the main panel, with a thread on it, and a click aimed
 *  at `blockId` from inside that thread's card. */
const clickFromCard = async (blockId: string, overrides: Partial<NavigatePanelInput> = {}) => {
  await navigate(repo, {blockId: 'page', target: 'main'})
  const panelId = await shownPanel()
  const {threadId} = await createThread(repo, {targetId: 'page', anchor: null, comment: 'See the point'})
  const card = cardRenderScopeId('margin', panelRenderScopeId(panelId, 'page'), threadId)
  const result = await navigate(repo, {
    blockId, target: 'panel', panelId, origin: 'follow-link', sourceRenderScopeId: card, ...overrides,
  })
  const panel = repo.block(panelId)
  await panel.load()
  return {panelId, result, focused: peekFocusedBlockLocation(panel)}
}

describe('a link in a comment', () => {
  it('to a block of the page shown keeps the page, revealing and focusing the block in it', async () => {
    const {panelId, result, focused} = await clickFromCard('point')

    expect(await shownBlocks()).toEqual(['page'])
    expect(result).toMatchObject({panelId, blockId: 'point'})
    expect(focused).toEqual({blockId: 'point', renderScopeId: panelRenderScopeId(panelId, 'page')})
    expect((await repo.load('section'))!.properties[isCollapsedProp.name]).toBe(false)
  })

  it('to a block on another page navigates to it', async () => {
    await clickFromCard('elsewhere')
    expect(await shownBlocks()).toEqual(['elsewhere'])
  })

  it('to the page itself navigates as before', async () => {
    const {focused} = await clickFromCard('page')
    expect(await shownBlocks()).toEqual(['page'])
    expect(focused?.blockId).not.toBe('point')
  })

  it('a zoom from a bullet is not a link click', async () => {
    await clickFromCard('point', {origin: 'zoom'})
    expect(await shownBlocks()).toEqual(['point'])
  })
})

describe('a link outside a comment', () => {
  it('navigates to the block', async () => {
    await navigate(repo, {blockId: 'page', target: 'main'})
    const panelId = await shownPanel()
    await navigate(repo, {
      blockId: 'point', target: 'panel', panelId, origin: 'follow-link',
      sourceRenderScopeId: panelRenderScopeId(panelId, 'page'),
    })
    expect(await shownBlocks()).toEqual(['point'])
  })
})

describe('the comments that link a block', () => {
  /** Block links parse only a uuid. */
  const LINKED = '6d1f3e0a-2b7c-4c1e-9a55-0f1d2c3b4a59'
  const link = `[the point](((${LINKED})))`

  beforeEach(async () => {
    await repo.tx(tx => tx.create({id: LINKED, workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'Linked'}), opts)
  })

  const linksOf = () => repo.query[COMMENT_LINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: LINKED}).load()

  it('are the comments, replies included, of open threads elsewhere', async () => {
    const onPage = await createThread(repo, {targetId: 'page', anchor: null, comment: 'Overall'})
    const reply = await repo.mutate.createChild({parentId: onPage.commentId!, content: `See ${link}`})
    const first = await createThread(repo, {targetId: 'point', anchor: null, comment: `Like ${link}`})
    const resolved = await createThread(repo, {targetId: 'point', anchor: null, comment: `Also ${link}`})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    await createThread(repo, {targetId: LINKED, anchor: null, comment: `This, ${link}`})
    await repo.mutate.createChild({parentId: 'page', content: `Not a comment: ${link}`})

    // Credit is a property edge, not a link.
    const credited = await repo.mutate.createChild({parentId: first.commentId!, content: 'plain words'})
    await repo.tx(tx => tx.setProperty(credited, attributionCreatorsProp, [LINKED]), opts)

    await vi.waitFor(async () => expect(await linksOf()).toHaveLength(2))
    expect(new Set(await linksOf())).toEqual(new Set([
      {commentId: reply, threadId: onPage.threadId},
      {commentId: first.commentId, threadId: first.threadId},
    ]))
  })
})

describe('goToComment', () => {
  const focusIn = async (panelId: string) => {
    const panel = repo.block(panelId)
    await panel.load()
    return peekFocusedBlockLocation(panel)
  }

  it('shows a comment of a thread on the page in its card, keeping the page', async () => {
    await navigate(repo, {blockId: 'page', target: 'main'})
    const panelId = await shownPanel()
    const {threadId, commentId} = await createThread(repo, {targetId: 'point', anchor: null, comment: 'Hm'})

    await goToComment(repo, panelId, commentId!)

    expect(await shownBlocks()).toEqual(['page'])
    expect((await repo.load('section'))!.properties[isCollapsedProp.name]).toBe(false)
    expect(await focusIn(panelId)).toEqual({
      blockId: commentId,
      renderScopeId: cardRenderScopeId('comments', panelRenderScopeId(panelId, 'page'), threadId),
    })
  })

  it('navigates to a comment of a thread on another page', async () => {
    await navigate(repo, {blockId: 'page', target: 'main'})
    const panelId = await shownPanel()
    const {commentId} = await createThread(repo, {targetId: 'elsewhere', anchor: null, comment: 'Hm'})

    await goToComment(repo, panelId, commentId!)

    expect(await shownBlocks()).toEqual(['elsewhere'])
  })
})

describe('the comments that link a block, as threads change', () => {
  const LINKED = '6d1f3e0a-2b7c-4c1e-9a55-0f1d2c3b4a59'

  beforeEach(async () => {
    await repo.tx(tx => tx.create({id: LINKED, workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'Linked'}), opts)
  })

  it('follows a reply whose parent comment moves to an open thread', async () => {
    const resolved = await createThread(repo, {targetId: 'point', anchor: null, comment: 'Parent'})
    const reply = await repo.mutate.createChild({parentId: resolved.commentId!, content: `See [it](((${LINKED})))`})
    await repo.mutate.createChild({parentId: resolved.threadId, content: 'Another'})
    await setThreadStatus(repo, resolved.threadId, 'resolved')
    const handle = repo.query[COMMENT_LINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: LINKED})
    const seen: unknown[] = []
    const stop = handle.subscribe(value => { seen.push(value) })
    await vi.waitFor(async () => expect(await handle.load()).toEqual([]))

    const moved = await moveToOwnThread(repo, {commentId: resolved.commentId!, targetId: 'elsewhere'})

    await vi.waitFor(() => expect(seen.at(-1)).toEqual([{commentId: reply, threadId: moved}]))
    stop()
  })
})

describe('goToComment in a read-only workspace', () => {
  it('opens a comment hidden under a collapsed comment instead of expanding it', async () => {
    await navigate(repo, {blockId: 'page', target: 'main'})
    const panelId = await shownPanel()
    // On the page itself, which shows: only the comment above the reply hides it.
    const {commentId} = await createThread(repo, {targetId: 'page', anchor: null, comment: 'Parent'})
    const reply = await repo.mutate.createChild({parentId: commentId!, content: 'Reply'})
    await repo.tx(tx => tx.setProperty(commentId!, isCollapsedProp, true), opts)
    repo.setReadOnly(true)
    try {
      await goToComment(repo, panelId, reply)
    } finally {
      repo.setReadOnly(false)
    }
    expect((await repo.load(commentId!))!.properties[isCollapsedProp.name]).toBe(true)
    expect(await shownBlocks()).toEqual([reply])
  })
})
