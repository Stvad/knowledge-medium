// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { keysBetween } from '@/data/orderKey'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import {
  PanelLayoutProjection,
  activatePanelRow,
  applyCurrentLayoutUrl,
  createPanelRowInTx,
  deletePanelRow,
  insertPanelRow,
  layoutBlockIdsFromRows,
  layoutSlotsFromRows,
  panelBlockIds,
  panelBlockId,
  retargetPanelBlockIds,
} from '@/utils/panelLayoutProjection'
import { panelHistory } from '@/utils/panelHistory'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  layoutSessionBlockId: string
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSessionBlock = await getLayoutSessionBlock(uiState, 'layout-session-a')
  return {h, repo, layoutSessionBlockId: layoutSessionBlock.id}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const layoutSessionBlock = () => env.repo.block(env.layoutSessionBlockId)

const createPanelRows = async (blockIds: readonly string[]): Promise<void> => {
  const parent = layoutSessionBlock()
  await env.repo.tx(async tx => {
    const parentData = await tx.get(parent.id)
    if (!parentData) throw new Error('missing layout session block')
    const orderKeys = keysBetween(null, null, blockIds.length)
    for (let index = 0; index < blockIds.length; index++) {
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: orderKeys[index],
        blockId: blockIds[index],
      })
    }
  }, {scope: ChangeScope.UiState, description: 'seed panel rows'})
}

const rows = async () => layoutSessionBlock().children.load()
const layoutRows = async () => env.repo.query.subtree({id: env.layoutSessionBlockId}).load()

const rowIdsByBlock = async (): Promise<Map<string, string>> =>
  new Map((await layoutRows())
    .map(row => [panelBlockId(row), row.id] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0])))

describe('applyCurrentLayoutUrl', () => {
  it('creates panel rows for an explicit layout URL', async () => {
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })

    expect(result.kind).toBe('applied')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('creates a sidebar stack for stack layout URLs', async () => {
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/(s:x,b)/c',
    })

    expect(result.kind).toBe('applied')
    const treeRows = await layoutRows()
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, treeRows)).toEqual(['a', 'x', 'b', 'c'])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, treeRows)).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'x'},
          {kind: 'leaf', blockId: 'b'},
        ],
      },
      {kind: 'leaf', blockId: 'c'},
    ])
  })

  it('repairs active panel when URL reconciliation deletes the active row', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b/c',
    })
    const beforeByBlock = await rowIdsByBlock()
    const rowB = beforeByBlock.get('b')
    if (!rowB) throw new Error('missing panel row b')
    await layoutSessionBlock().set(activePanelIdProp, rowB)

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/c',
    })

    const afterRows = await layoutRows()
    const activePanelId = layoutSessionBlock().peekProperty(activePanelIdProp)
    const activeRow = afterRows.find(row => row.id === activePanelId)
    expect(activeRow ? panelBlockId(activeRow) : undefined).toBe('c')
    expect(activePanelId).not.toBe(rowB)
  })

  it('clears stale active panel when the URL already matches the layout', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/c',
    })
    await layoutSessionBlock().set(activePanelIdProp, 'deleted-panel-b')

    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/c',
    })

    expect(result.kind).toBe('noop')
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBeUndefined()
  })

  it('inserts in the middle while preserving surviving row ids', async () => {
    await createPanelRows(['a', 'c'])
    const before = await rowIdsByBlock()

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b/c',
    })

    const afterRows = await rows()
    const after = await rowIdsByBlock()
    expect(panelBlockIds(afterRows)).toEqual(['a', 'b', 'c'])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('c')).toBe(before.get('c'))
    expect(after.get('b')).toBeTruthy()
  })

  it('reuses the changed slot and reconciles panel-local history on URL back', async () => {
    await createPanelRows(['a', 'b'])
    const before = await rowIdsByBlock()
    const rowB = before.get('b')
    if (!rowB) throw new Error('missing b row')

    panelHistory.push(rowB, {
      blockId: 'x',
      state: {
        focusedLocation: {blockId: 'x-child', renderScopeId: outlineRenderScopeId('x')},
        scrollTop: 42,
      },
    })

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/x',
    })

    const after = await rowIdsByBlock()
    expect(after.get('x')).toBe(rowB)
    expect(env.repo.block(rowB).peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'x-child',
      renderScopeId: outlineRenderScopeId('x'),
    })
    expect(panelHistory.consumeRestore(rowB)).toEqual({
      focusedLocation: {blockId: 'x-child', renderScopeId: outlineRenderScopeId('x')},
      scrollTop: 42,
    })
    expect(panelHistory.getSnapshot(rowB).forward.map(entry => entry.blockId)).toEqual(['b'])
  })

  it('preserves row ids when the URL reorders existing panels', async () => {
    await createPanelRows(['a', 'b', 'c'])
    const before = await rowIdsByBlock()

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/c/a/b',
    })

    const after = await rowIdsByBlock()
    expect(panelBlockIds(await rows())).toEqual(['c', 'a', 'b'])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('b')).toBe(before.get('b'))
    expect(after.get('c')).toBe(before.get('c'))
  })

  it('normalizes a bare workspace URL to existing layout session rows without writing rows', async () => {
    await createPanelRows(['a', 'b'])
    let replaced = ''

    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1',
      replaceHash: hash => { replaced = hash },
    })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('preserves hash query params when normalizing a bare workspace URL', async () => {
    await createPanelRows(['a', 'b'])
    let replaced = ''

    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1?agent-runtime-secret=secret&agent-runtime-open-tokens=1',
      replaceHash: hash => { replaced = hash },
    })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b?agent-runtime-secret=secret&agent-runtime-open-tokens=1')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('ignores URLs for another workspace', async () => {
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#other/a',
    })

    expect(result.kind).toBe('ignored')
    expect(panelBlockIds(await rows())).toEqual([])
  })
})

describe('retargetPanelBlockIds', () => {
  it('retargets every panel currently showing the merged source block', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/source/(s:other,source)',
    })

    const beforeRows = await layoutRows()
    const sourceRows = beforeRows.filter(row => panelBlockId(row) === 'source')
    expect(sourceRows).toHaveLength(2)

    await retargetPanelBlockIds(env.repo, layoutSessionBlock(), 'source', 'target')

    const afterRows = await layoutRows()
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      'target',
      'other',
      'target',
    ])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      {kind: 'leaf', blockId: 'target'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'other'},
          {kind: 'leaf', blockId: 'target'},
        ],
      },
    ])
    for (const row of sourceRows) {
      expect(env.repo.block(row.id).peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'target',
        renderScopeId: outlineRenderScopeId('target'),
      })
      expect(env.repo.block(row.id).peekProperty(scrollTopProp)).toBe(0)
    }
  })

  it('uses panel-history restore state when the target is adjacent in history', async () => {
    await createPanelRows(['source'])
    const [row] = await rows()
    panelHistory.push(row.id, {
      blockId: 'target',
      state: {
        focusedLocation: {
          blockId: 'target-child',
          renderScopeId: outlineRenderScopeId('target'),
        },
        scrollTop: 42,
      },
    })

    await retargetPanelBlockIds(env.repo, layoutSessionBlock(), 'source', 'target')

    expect(env.repo.block(row.id).peekProperty(topLevelBlockIdProp)).toBe('target')
    expect(env.repo.block(row.id).peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'target-child',
      renderScopeId: outlineRenderScopeId('target'),
    })
    expect(env.repo.block(row.id).peekProperty(scrollTopProp)).toBe(42)
    expect(panelHistory.consumeRestore(row.id)).toEqual({
      focusedLocation: {
        blockId: 'target-child',
        renderScopeId: outlineRenderScopeId('target'),
      },
      scrollTop: 42,
    })
    expect(panelHistory.getSnapshot(row.id).forward.map(entry => entry.blockId)).toEqual(['source'])
  })
})

describe('insertPanelRow', () => {
  it('inserts after a panel tied with its next sibling without throwing (#198)', async () => {
    // Two panels share an order_key ('a1'); a third sits after at 'a2'. Inserting
    // after the first tied panel used keyBetween(equal, equal), which threw
    // "<key> >= <key>" and rolled back the insert. Precise placement opens a slot
    // between the tied pair instead (re-keying the second panel).
    const parent = layoutSessionBlock()
    await env.repo.tx(async tx => {
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a1', blockId: 'b1'})
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a1', blockId: 'b2'})
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a2', blockId: 'b3'})
    }, {scope: ChangeScope.UiState, description: 'seed tied panels'})

    // The two tied panels render first (by id tiebreak); pick whichever sorts
    // first so its NEXT sibling is the tied one — that's the equal-bounds case.
    const seeded = (await rows()).map(row => row.id)
    const newId = await insertPanelRow(env.repo, parent, 'b4', {afterPanelId: seeded[0]})

    // Lands EXACTLY after the source panel — between the two tied panels
    // (re-keys the second), not past the whole run. Nothing rolled back.
    expect((await rows()).map(row => row.id)).toEqual([seeded[0], newId, seeded[1], seeded[2]])
  })
})

describe('deletePanelRow', () => {
  it('activates the next sibling in a stack when closing the active stacked panel', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/(s:x,b,y)/c',
    })
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    const rowY = byBlock.get('y')
    if (!rowB || !rowY) throw new Error('missing stacked rows')

    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await deletePanelRow(env.repo, rowB)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowY)
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      'a',
      'x',
      'y',
      'c',
    ])
  })

  it('falls back to the previous sibling before leaving the stack', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/(s:x,b,y)/c',
    })
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    const rowY = byBlock.get('y')
    if (!rowB || !rowY) throw new Error('missing stacked rows')

    await layoutSessionBlock().set(activePanelIdProp, rowY)
    await deletePanelRow(env.repo, rowY)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowB)
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      'a',
      'x',
      'b',
      'c',
    ])
  })

  it('keeps climbing out of nested stacks to find the next panel', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/(s:(s:b))/c',
    })
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    if (!rowB) throw new Error('missing nested stack row')

    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await deletePanelRow(env.repo, rowB)

    const afterRows = await layoutRows()
    const activePanelId = layoutSessionBlock().peekProperty(activePanelIdProp)
    const activeRow = afterRows.find(row => row.id === activePanelId)
    expect(activeRow ? panelBlockId(activeRow) : undefined).toBe('c')
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      'a',
      'c',
    ])
  })
})

describe('activatePanelRow', () => {
  it('ignores activation for deleted panel rows', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing panel rows')
    await layoutSessionBlock().set(activePanelIdProp, rowA)
    await env.repo.tx(tx => tx.delete(rowB), {
      scope: ChangeScope.UiState,
      description: 'delete panel row for activation guard',
    })

    await activatePanelRow(env.repo, env.layoutSessionBlockId, rowB)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowA)
  })

  it('rejects already-active rows moved out of the layout session', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    if (!rowB) throw new Error('missing panel row b')
    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await env.repo.tx(tx => tx.move(rowB, {parentId: null, orderKey: 'z0'}), {
      scope: ChangeScope.UiState,
      description: 'move panel row out of layout session',
    })

    await expect(activatePanelRow(env.repo, env.layoutSessionBlockId, rowB))
      .resolves.toBe(false)
  })
})

describe('PanelLayoutProjection', () => {
  it('pushes a URL when subscribed panel rows change', async () => {
    await createPanelRows(['a'])
    let currentHash = '#ws-1/a'
    let pushed = ''
    let notified = 0
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => {
        pushed = hash
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    const unsubscribe = projection.subscribe(() => { notified += 1 })
    await projection.start()

    const [row] = await rows()
    await env.repo.tx(async tx => {
      await tx.setProperty(row.id, topLevelBlockIdProp, 'b')
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})

    await vi.waitFor(() => expect(pushed).toBe('#ws-1/b'))
    expect(notified).toBeGreaterThan(0)
    unsubscribe()
    projection.dispose()
  })

  it('pushes a stack URL when nested panel rows change', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/(s:x,b)',
    })
    let currentHash = '#ws-1/a/(s:x,b)'
    let pushed = ''
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => {
        pushed = hash
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    await projection.start()

    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    await env.repo.tx(async tx => {
      await tx.setProperty(rowB, topLevelBlockIdProp, 'y')
    }, {scope: ChangeScope.UiState, description: 'navigate nested panel'})

    await vi.waitFor(() => expect(pushed).toBe('#ws-1/a/(s:x,y)'))
    projection.dispose()
  })

  it('notifies subscribers when the URL moves to another workspace', async () => {
    await createPanelRows(['a'])
    let currentHash = '#other/a'
    let notified = 0
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => { currentHash = hash },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    const unsubscribe = projection.subscribe(() => { notified += 1 })
    await projection.start()

    await projection.applyCurrentUrl()

    expect(notified).toBe(1)
    unsubscribe()
    projection.dispose()
  })
})
