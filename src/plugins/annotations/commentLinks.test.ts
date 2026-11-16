// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
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
import {annotationsPlugin} from './index'
import {createThread} from './threads'
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
  repo = createTestRepo({db: db.db, user: USER, extensions: [referencesDataExtension, annotationsPlugin]}).repo
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
