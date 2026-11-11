// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, type User} from '@/data/api'
import {isCollapsedProp, peekFocusedBlockLocation} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {getLayoutSessionBlock, getUIStateBlock} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {__resetLayoutSessionIdForTesting} from '@/utils/layoutSessionId'
import {isSurfaceZoom, navigate} from '@/utils/navigation'
import {panelBlockIds} from '@/utils/panelLayoutProjection'
import {panelRenderScopeId, surfaceRenderScopeId} from '@/utils/renderScope'
import {
  __resetSurfaceZoomsForTesting,
  peekSurfaceZoom,
  registerZoomableSurface,
  zoomPath,
} from '@/utils/surfaceZoom'

const WS = 'ws'
const USER: User = {id: 'alex', name: 'Alex'}
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
let panelId: string
/** The surface on `root`, mounted in the panel's outline. */
let scope: string

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

/** `page` and `other` are roots; a surface shows `root > a > b > c`. */
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  __resetSurfaceZoomsForTesting()
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    const block = (id: string, parentId: string | null) =>
      tx.create({id, workspaceId: WS, parentId, orderKey: 'a0', content: id})
    await block('page', null)
    await block('other', null)
    await block('root', null)
    await block('a', 'root')
    await block('b', 'a')
    await block('c', 'b')
  }, opts)
  await navigate(repo, {blockId: 'page', target: 'main'})
  panelId = (await panelRows())[0].id
  scope = surfaceRenderScopeId('test', panelRenderScopeId(panelId, 'page'), 'root')
  registerZoomableSurface(scope, {rootId: 'root', parentRenderScopeId: panelRenderScopeId(panelId, 'page')})
})

const panelRows = async () => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  return (await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)).children.load()
}

const shown = async () => panelBlockIds(await panelRows())

const zoom = (blockId: string, origin = 'zoom', sourceRenderScopeId = scope) =>
  navigate(repo, {blockId, target: 'panel', panelId, origin, sourceRenderScopeId})

describe('a zoom made inside a zoomable surface', () => {
  it('zooms the surface and focuses the block in it, leaving the panel where it is', async () => {
    const result = await zoom('b')

    expect(result).toMatchObject({panelId, blockId: 'page'})
    expect(await shown()).toEqual(['page'])
    expect(peekSurfaceZoom(scope)).toBe('b')
    const panel = repo.block(panelId)
    await panel.load()
    expect(peekFocusedBlockLocation(panel)).toEqual({blockId: 'b', renderScopeId: scope})
  })

  it('onto the surface’s root shows all of it again', async () => {
    await zoom('b')

    await zoom('root')

    expect(peekSurfaceZoom(scope)).toBeUndefined()
    expect(await shown()).toEqual(['page'])
  })

  it('expands a collapsed block it zooms into', async () => {
    await repo.tx(tx => tx.setProperty('b', isCollapsedProp, true), opts)

    await zoom('b')

    expect((await repo.load('b'))?.properties[isCollapsedProp.name]).toBeFalsy()
  })

  it('out steps to the parent, then to the whole surface, then is the panel’s', async () => {
    await zoom('c')

    await zoom('other', 'zoom-out')
    expect(peekSurfaceZoom(scope)).toBe('b')

    await zoom('other', 'zoom-out')
    await zoom('other', 'zoom-out')
    expect(peekSurfaceZoom(scope)).toBeUndefined()
    expect(await shown()).toEqual(['page'])

    await zoom('other', 'zoom-out')
    expect(await shown()).toEqual(['other'])
  })

  it('out of a surface nested in a zoomed surface’s row steps the outer one', async () => {
    const inner = surfaceRenderScopeId('test', scope, 'other')
    registerZoomableSurface(inner, {rootId: 'other', parentRenderScopeId: scope})
    await zoom('b')

    await zoom('other', 'zoom-out', inner)

    expect(peekSurfaceZoom(scope)).toBe('a')
    expect(await shown()).toEqual(['page'])
  })

  it('out is the panel’s once the zoomed block has left the surface', async () => {
    await zoom('b')
    await repo.mutate.delete({id: 'b'})

    await zoom('other', 'zoom-out')

    expect(peekSurfaceZoom(scope)).toBeUndefined()
    expect(await shown()).toEqual(['other'])
  })

  it('is the panel’s when made in a scope that is not a mounted surface', async () => {
    await zoom('b', 'zoom', panelRenderScopeId(panelId, 'page'))

    expect(peekSurfaceZoom(scope)).toBeUndefined()
    expect(await shown()).toEqual(['b'])
  })

  it('is a navigation when it opens another panel, or is not a zoom', async () => {
    const from = {blockId: 'b', origin: 'zoom', sourceRenderScopeId: scope}
    expect(isSurfaceZoom({...from, target: 'new-panel', sourcePanelId: panelId})).toBe(false)
    expect(isSurfaceZoom({...from, target: 'panel', panelId, origin: 'follow-link'})).toBe(false)
    expect(isSurfaceZoom({...from, target: 'panel', panelId})).toBe(true)
  })
})

describe('zoomPath', () => {
  const chain = [{id: 'b'}, {id: 'a'}, {id: 'root'}, {id: 'page'}]

  it('lists the blocks between the root and the zoomed block, outermost first', () => {
    expect(zoomPath(chain, 'root')).toEqual([{id: 'a'}, {id: 'b'}])
  })

  it('is empty for the root’s child, and null for a block outside the root', () => {
    expect(zoomPath(chain.slice(2), 'root')).toEqual([])
    expect(zoomPath(chain, 'elsewhere')).toBeNull()
  })
})
