// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockData, type User } from '@/data/api'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { keysBetween } from '@/data/orderKey'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  panelViewModeProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { buildLayoutFromSlots } from '@/utils/routing'
import { outlineRenderScopeId } from '@/utils/renderScope'
import {
  PanelLayoutProjection,
  activatePanelRow,
  applyCurrentLayoutUrl,
  createPanelRowInTx,
  createPanelStackRowInTx,
  deletePanelRow,
  insertPanelRow,
  layoutBlockIdsFromRows,
  layoutSlotsFromRows,
  panelBlockIds,
  panelBlockId,
  reconcilePanelRows,
  retargetPanelBlockIds,
} from '@/utils/panelLayoutProjection'
import {
  goBackInPanel,
  goForwardInPanel,
  navigateInPanel,
  panelHistory,
} from '@/utils/panelHistory'

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

const startProjection = (initialHash: string) => {
  let currentHash = initialHash
  const pushes: string[] = []
  const replaces: string[] = []
  const projection = new PanelLayoutProjection({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: layoutSessionBlock(),
    getHash: () => currentHash,
    pushHash: hash => {
      pushes.push(hash)
      currentHash = hash
    },
    replaceHash: hash => {
      replaces.push(hash)
      currentHash = hash
    },
    subscribeToUrl: () => () => {},
  })
  return {
    projection,
    pushes,
    replaces,
    hash: () => currentHash,
    setHash: (hash: string) => { currentHash = hash },
  }
}

// Deterministic interleaving needs direct delivery of a rows event —
// real subscription timing is not controllable from a test.
const deliverRowsEvent = (projection: PanelLayoutProjection, rows: readonly BlockData[]) => {
  (projection as unknown as {handleRowsChanged(rows: readonly BlockData[]): void}).handleRowsChanged(rows)
}

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
      hash: '#ws-1/a/x,b/c',
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

  it('degrades a URL-borne sublayout column to a stack and normalizes the hash', async () => {
    let replaced = ''
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/(a/b)/c',
      replaceHash: hash => { replaced = hash },
    })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a,b/c')
    const treeRows = await layoutRows()
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, treeRows)).toEqual([
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'a'},
          {kind: 'leaf', blockId: 'b'},
        ],
      },
      {kind: 'leaf', blockId: 'c'},
    ])
  })

  it('degrades a single-leaf sublayout column to a plain leaf', async () => {
    let replaced = ''
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/(a)/c',
      replaceHash: hash => { replaced = hash },
    })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/c')
    expect(panelBlockIds(await rows())).toEqual(['a', 'c'])
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

describe('reconcilePanelRows failure safety', () => {
  it('keeps panel history for rows whose delete is rolled back by a mid-tx throw', async () => {
    await createPanelRows(['a', 'b'])
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    panelHistory.push(rowB, {
      blockId: 'prev',
      state: {scrollTop: 7},
    })

    // A sublayout slot reaching reconcilePanelRows directly is an internal
    // error (the URL boundary degrades them) — it throws mid-tx AFTER the
    // delete of row b was staged. The tx rolls back; row b's in-memory
    // history must survive with it.
    await expect(reconcilePanelRows(env.repo, layoutSessionBlock(), [
      {kind: 'sublayout', columns: [{kind: 'leaf', blockId: 'x'}]},
    ])).rejects.toThrow()

    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
    expect(panelHistory.getSnapshot(rowB).back.map(entry => entry.blockId)).toEqual(['prev'])
  })
})

describe('panel history clears run after the tx commits', () => {
  // Pin the ORDER by making clear itself throw: if clear ran before (or
  // inside) the tx, the row write would never commit; committed rows +
  // a rejected call prove clear happened strictly after the commit.
  it('deletePanelRow: the row is already deleted when clear runs', async () => {
    await createPanelRows(['a', 'b'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const clearSpy = vi.spyOn(panelHistory, 'clear').mockImplementation(() => {
      throw new Error('boom: clear after commit probe')
    })
    try {
      await expect(deletePanelRow(env.repo, rowA)).rejects.toThrow('clear after commit probe')
      expect(clearSpy).toHaveBeenCalledWith(rowA)
    } finally {
      clearSpy.mockRestore()
    }
    expect(panelBlockIds(await rows())).toEqual(['b']) // delete committed before clear ran
  })

  it('reconcilePanelRows: deletes are already committed when clear runs', async () => {
    await createPanelRows(['a', 'b'])
    const clearSpy = vi.spyOn(panelHistory, 'clear').mockImplementation(() => {
      throw new Error('boom: clear after commit probe')
    })
    try {
      await expect(reconcilePanelRows(env.repo, layoutSessionBlock(), ['a']))
        .rejects.toThrow('clear after commit probe')
    } finally {
      clearSpy.mockRestore()
    }
    expect(panelBlockIds(await rows())).toEqual(['a']) // reconcile committed before clear ran
  })
})

describe('layoutSlotsFromRows normalization', () => {
  const seedStack = async (childBlockIds: readonly string[]): Promise<string> => {
    const parent = layoutSessionBlock()
    let stackId = ''
    await env.repo.tx(async tx => {
      const parentData = await tx.get(parent.id)
      if (!parentData) throw new Error('missing layout session block')
      const [keyLeaf, keyStack] = keysBetween(null, null, 2)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyLeaf,
        blockId: 'a',
      })
      stackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyStack,
      })
      const childKeys = keysBetween(null, null, Math.max(childBlockIds.length, 1))
      for (let index = 0; index < childBlockIds.length; index++) {
        await createPanelRowInTx(env.repo, tx, {
          workspaceId: parentData.workspaceId,
          parentId: stackId,
          orderKey: childKeys[index],
          blockId: childBlockIds[index],
        })
      }
    }, {scope: ChangeScope.UiState, description: 'seed stack rows'})
    return stackId
  }

  it('collapses a singleton stack to its leaf', async () => {
    await seedStack(['x'])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {kind: 'leaf', blockId: 'x'},
    ])
  })

  it('drops an empty stack entirely', async () => {
    await seedStack([])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
    ])
  })

  it('makes a reload round with a singleton stack a noop that keeps all row ids', async () => {
    const stackId = await seedStack(['x'])
    const rowsBefore = await layoutRows()
    const idsBefore = rowsBefore.map(row => row.id).sort()
    expect(idsBefore).toContain(stackId)

    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/x', // what buildLayoutFromSlots emits for the collapsed slots
    })

    expect(result.kind).toBe('noop')
    const idsAfter = (await layoutRows()).map(row => row.id).sort()
    expect(idsAfter).toEqual(idsBefore) // the stack row silently survives
  })
})

describe('slot context on rows (slice 2)', () => {
  const applyUrl = (hash: string) => applyCurrentLayoutUrl({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: layoutSessionBlock(),
    hash,
  })

  const seedContext = async (viewModeRowId: string, activeRowId: string) => {
    await env.repo.tx(async tx => {
      await tx.setProperty(viewModeRowId, panelViewModeProp, 'video-notes')
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, activeRowId)
    }, {scope: ChangeScope.UiState, description: 'seed slot context'})
  }

  it('layoutSlotsFromRows emits viewMode and active from the row/session props', async () => {
    await createPanelRows(['a', 'b'])
    const byBlock = await rowIdsByBlock()
    await seedContext(byBlock.get('a')!, byBlock.get('b')!)

    const slots = layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())
    expect(slots).toEqual([
      {kind: 'leaf', blockId: 'a', viewMode: 'video-notes'},
      {kind: 'leaf', blockId: 'b', active: true},
    ])
    // Single slots→hash integration checkpoint (encoding itself is pinned
    // in the routing tests).
    expect(buildLayoutFromSlots(WS, slots)).toBe('#ws-1/a;view=video-notes/b;active')
  })

  it('inbound ;view sets panelViewMode on the SAME row; inbound without it clears', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await applyUrl('#ws-1/a;view=m/b')
    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')

    await applyUrl('#ws-1/a/b')
    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
  })

  it('an unknown mode value round-trips opaquely through the prop', async () => {
    await applyUrl('#ws-1/a;view=some%20unknown%2Fmode')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('some unknown/mode')
  })

  it('inbound ;active coerces activePanelIdProp to that slot row', async () => {
    await applyUrl('#ws-1/a/b;active')
    const byBlock = await rowIdsByBlock()
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('b'))
  })

  it('inbound with two ;active — first wins', async () => {
    await applyUrl('#ws-1/a;active/b;active')
    const byBlock = await rowIdsByBlock()
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('a'))
  })

  it('inbound without ;active leaves activePanelIdProp untouched', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    await layoutSessionBlock().set(activePanelIdProp, rowA)

    await applyUrl('#ws-1/a;view=m/b') // real diff (mode), but no active entry
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowA)
  })

  it('an empty-string viewMode prop reads as absent', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, '')
    }, {scope: ChangeScope.UiState, description: 'write empty mode'})

    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
    ])
  })

  it('a mode-only inbound diff updates the prop in place: row id, focus, scroll untouched', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const focusedLocation = {blockId: 'a-child', renderScopeId: outlineRenderScopeId('a')}
    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, focusedBlockLocationProp, focusedLocation)
      await tx.setProperty(rowA, scrollTopProp, 42)
    }, {scope: ChangeScope.UiState, description: 'seed panel state'})

    await applyUrl('#ws-1/a;view=m/b')

    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(env.repo.block(rowA).peekProperty(focusedBlockLocationProp)).toEqual(focusedLocation)
    expect(env.repo.block(rowA).peekProperty(scrollTopProp)).toBe(42)
  })
})

describe('view-mode navigation semantics (slice 3)', () => {
  const applyUrl = (hash: string) => applyCurrentLayoutUrl({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: layoutSessionBlock(),
    hash,
  })
  const panelBlock = (rowId: string) => env.repo.block(rowId)
  const rowFor = async (blockId: string) => {
    const rowId = (await rowIdsByBlock()).get(blockId)
    if (!rowId) throw new Error(`missing ${blockId} row`)
    return rowId
  }
  // Mirrors PanelRenderer's snapshotter: capture the live mode at push time.
  const registerLiveSnapshotter = (rowId: string) =>
    panelHistory.registerSnapshotter(rowId, () => ({
      viewMode: env.repo.block(rowId).peekProperty(panelViewModeProp),
      scrollTop: 7,
    }))

  it('navigateInPanel with viewMode: one viewModeEnter-stamped entry, ONE push carrying both changes', async () => {
    await applyUrl('#ws-1/a')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'video-block', {viewMode: 'video-notes'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/video-block;view=video-notes']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('video-notes')
    expect(panelHistory.getSnapshot(rowA).back).toEqual([
      {blockId: 'a', viewModeEnter: 'video-notes'},
    ])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('plain navigateInPanel away from a moded pane clears the mode: ONE push without ;view, no viewModeEnter', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'b')

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
    // strict: the entry must not even carry a viewModeEnter KEY
    expect(panelHistory.getSnapshot(rowA).back).toStrictEqual([
      {blockId: 'a', state: undefined},
    ])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('same-block enter: mode-only tx, ONE push with ;view, no history entry', async () => {
    await applyUrl('#ws-1/a')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: 'm'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(env.repo.block(rowA).peekProperty(topLevelBlockIdProp)).toBe('a')
    // not a navigation: no entry, no viewModeEnter stamp anywhere
    expect(panelHistory.getSnapshot(rowA)).toStrictEqual({back: [], forward: []})
    projection.dispose()
  })

  it('same-block re-enter with the same mode is a true no-op (no push)', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: 'm'})

    // fence: a real change must still push, and it must be the ONLY push
    await navigateInPanel(panelBlock(rowA), 'b')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    expect(replaces).toEqual([])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('same-block plain navigate preserves the mode; explicit undefined clears it', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes} = startProjection('#ws-1/a;view=m')
    await projection.start()

    // Plain re-navigation to the open block (zoom-in, re-click) is a pure
    // no-op: the mode belongs to the (pane, block) pair and neither changed.
    await navigateInPanel(panelBlock(rowA), 'a')
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(pushes).toEqual([])

    // The explicit clear-only form (slice-5 close) removes the mode without
    // a panelHistory entry; the browser-level entry comes from the push.
    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: undefined})
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a']))
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelHistory.getSnapshot(rowA)).toStrictEqual({back: [], forward: []})
    projection.dispose()
  })

  it('chevron forward across the enter boundary re-applies the mode', async () => {
    await applyUrl('#ws-1/plain')
    const row = await rowFor('plain')
    const unregister = registerLiveSnapshotter(row)

    await navigateInPanel(panelBlock(row), 'video', {viewMode: 'm'}) // enter
    await goBackInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('plain')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()

    await goForwardInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBe('m')
    // the enter marker survived the round trip (back-stack top re-stamped)
    expect(panelHistory.getSnapshot(row).back.at(-1)?.viewModeEnter).toBe('m')

    unregister()
    panelHistory.clear(row)
  })

  it('one URL applies a blockId+mode change to pane 1 and a mode-only change to pane 2', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing rows')

    await applyUrl('#ws-1/x;view=k/b;view=m')

    expect((await rowIdsByBlock()).get('x')).toBe(rowA) // reused across the content swap
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('k')
    expect(env.repo.block(rowB).peekProperty(panelViewModeProp)).toBe('m')
  })

  it('chevron back restores the moded visit, forward re-clears — one push per step', async () => {
    await applyUrl('#ws-1/video;view=m')
    const row = await rowFor('video')
    const unregister = registerLiveSnapshotter(row)
    const {projection, pushes} = startProjection('#ws-1/video;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(row), 'plain')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain']))
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()

    await goBackInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBe('m')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain', '#ws-1/video;view=m']))

    await goForwardInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('plain')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain', '#ws-1/video;view=m', '#ws-1/plain']))

    unregister()
    panelHistory.clear(row)
    projection.dispose()
  })

  it('URL-driven back ignores a conflicting VisitState viewMode — the hash is authoritative', async () => {
    await applyUrl('#ws-1/video;view=m')
    const row = await rowFor('video')
    const unregister = registerLiveSnapshotter(row)
    await navigateInPanel(panelBlock(row), 'plain')
    // history now holds {video, state:{viewMode:'m'}} — but the browser-Back
    // hash carries NO mode, and the URL wins over the remembered VisitState.
    await applyUrl('#ws-1/video')

    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()
    // reconciled as a back-step, not a fresh visit:
    expect(panelHistory.getSnapshot(row).forward.map(entry => entry.blockId)).toEqual(['plain'])

    unregister()
    panelHistory.clear(row)
  })
})

describe('context-only inbound diffs take the targeted pass', () => {
  const applyUrl = (hash: string, replaceHash?: (h: string) => void) => applyCurrentLayoutUrl({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: layoutSessionBlock(),
    hash,
    replaceHash,
  })

  const rowShapes = async () =>
    (await layoutRows()).map(row => ({id: row.id, parentId: row.parentId, orderKey: row.orderKey}))

  it('inbound without ;active over a stacked layout: all rows untouched, one replace adds ;active', async () => {
    await applyUrl('#ws-1/a/b,c')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)
    const before = await rowShapes()

    let replaced = ''
    const result = await applyUrl('#ws-1/a/b,c', h => { replaced = h })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b;active,c')
    expect(await rowShapes()).toEqual(before) // ids, parents, order keys — stack row intact
  })

  it('flat layout, inbound without ;active: no moves, one replace', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)
    const before = await rowShapes()

    let replaced = ''
    const result = await applyUrl('#ws-1/a/b', h => { replaced = h })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b;active')
    expect(await rowShapes()).toEqual(before)
  })

  it('inbound ;active coerces onto the REUSED row when topology matches', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('a')!)

    await applyUrl('#ws-1/a/b;active')

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('b'))
    expect((await rowIdsByBlock()).get('b')).toBe(byBlock.get('b')) // reused, not recreated
  })

  it('URL-active wins outright over repair when the old active row is deleted', async () => {
    await applyUrl('#ws-1/a/b/c')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)

    await applyUrl('#ws-1/a;active/c') // deletes b; repair would remap b→c, the URL says a

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('a'))
  })
})

describe('retargetPanelBlockIds', () => {
  it('retargets every panel currently showing the merged source block', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/source/other,source',
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
      hash: '#ws-1/a/x,b,y/c',
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
      hash: '#ws-1/a/x,b,y/c',
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
    // A stack nested inside a stack can no longer be expressed via a URL hash
    // under the comma grammar (stacks don't nest directly — see routing.ts);
    // seed the row structure directly to exercise deletePanelRow's climb-out
    // behavior through two stack levels.
    const parent = layoutSessionBlock()
    await env.repo.tx(async tx => {
      const parentData = await tx.get(parent.id)
      if (!parentData) throw new Error('missing layout session block')
      const [keyA, keyOuter, keyC] = keysBetween(null, null, 3)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyA,
        blockId: 'a',
      })
      const outerStackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyOuter,
      })
      const [innerKey] = keysBetween(null, null, 1)
      const innerStackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: outerStackId,
        orderKey: innerKey,
      })
      const [leafKey] = keysBetween(null, null, 1)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: innerStackId,
        orderKey: leafKey,
        blockId: 'b',
      })
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyC,
        blockId: 'c',
      })
    }, {scope: ChangeScope.UiState, description: 'seed nested stack rows'})

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
      hash: '#ws-1/a/x,b',
    })
    let currentHash = '#ws-1/a/x,b'
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

    await vi.waitFor(() => expect(pushed).toBe('#ws-1/a/x,y'))
    projection.dispose()
  })

  // Await the rows event on OUR OWN subscription to the same handle: the
  // projection subscribed first, so once we observe the intermediate rows
  // state the projection's handler has seen it too.
  const observeRows = () => {
    const seen: string[][] = []
    const unsubscribe = env.repo.query.subtree({id: env.layoutSessionBlockId}).subscribe(rows => {
      seen.push(layoutBlockIdsFromRows(env.layoutSessionBlockId, rows))
    })
    return {
      waitFor: (ids: readonly string[]) => vi.waitFor(() => {
        expect(seen.some(entry => entry.join('/') === ids.join('/'))).toBe(true)
      }),
      unsubscribe,
    }
  }

  const navigatePanel = async (panelRowId: string, blockId: string) => {
    await env.repo.tx(async tx => {
      await tx.setProperty(panelRowId, topLevelBlockIdProp, blockId)
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})
  }

  it('URL slot context round-trips through rows and the echo stays quiescent', async () => {
    // Slice-2 semantics: `;view=m` is no longer merely PRESERVED in the
    // hash — inbound it lands on the panel row, so the rows event that
    // follows carries the same context and the echo guard sees equality.
    await createPanelRows(['a'])
    const {projection, pushes, replaces, hash} = startProjection('#ws-1/b;view=m')
    await projection.start()
    const observer = observeRows()

    await projection.applyCurrentUrl() // inbound: row reused a→b, prop set
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    expect(env.repo.block(rowB).peekProperty(panelViewModeProp)).toBe('m')

    await observer.waitFor(['b']) // the reconcile's rows event was delivered
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])
    expect(hash()).toBe('#ws-1/b;view=m') // context retained via rows, not merely skipped

    // Fence: a REAL layout change must push. (Whether viewMode survives
    // in-panel navigation is slice-3's semantic — only pin the block id.)
    await navigatePanel(rowB, 'c')
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatch(/^#ws-1\/c/)
    observer.unsubscribe()
    projection.dispose()
  })

  it('an active-only diff replaces the hash exactly once and stabilizes', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'activate pane b'})

    await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/a/b;active']))
    expect(pushes).toEqual([])

    // Full-cycle stabilization: inbound the corrected hash is a noop —
    // no row writes, no further outbound replaces/pushes.
    await projection.applyCurrentUrl()
    expect(replaces).toEqual(['#ws-1/a/b;active'])
    expect(pushes).toEqual([])
    projection.dispose()
  })

  it('a viewMode change pushes (history entry by design)', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, 'm')
    }, {scope: ChangeScope.UiState, description: 'switch view mode'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m/b']))
    expect(replaces).toEqual([])
    projection.dispose()
  })

  it('a combined active+viewMode change pushes', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing rows')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, 'm')
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'switch mode and activate'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m/b;active']))
    expect(replaces).toEqual([])
    projection.dispose()
  })

  it('pushes exactly once for a real layout change under a context-bearing hash', async () => {
    await createPanelRows(['a'])
    const {projection, pushes} = startProjection('#ws-1/a;view=m')
    await projection.start()
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await navigatePanel(rowA, 'b')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    projection.dispose()
  })

  it('does not double-push when the hash carries query params and rows echo the layout', async () => {
    await createPanelRows(['a'])
    const {projection, pushes} = startProjection('#ws-1/b?agent-runtime-secret=s')
    await projection.start()
    const observer = observeRows()
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await navigatePanel(rowA, 'b') // echoes the hash's route despite the ?param
    await observer.waitFor(['b'])
    expect(pushes).toEqual([])

    await navigatePanel(rowA, 'c') // fence
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/c']))
    observer.unsubscribe()
    projection.dispose()
  })

  it('outbound writes preserve rest entries from the current hash', async () => {
    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      hash: '#ws-1/a/b',
    })
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;foo=1/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'activate pane b'})

    await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/a;foo=1/b;active']))
    expect(pushes).toEqual([])
    projection.dispose()
  })

  it('suppresses outbound writes while an inbound apply is pending (Back is not clobbered)', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, replaces, hash, setHash} = startProjection('#ws-1/a')
    await projection.start()

    // A pane-activation rows event exists but hasn't reached the projection.
    // Synthesize it (no DB write — keeps the interleaving deterministic).
    const staleRows = (await layoutRows()).map(row => row.id === env.layoutSessionBlockId
      ? {...row, properties: {...row.properties, [activePanelIdProp.name]: activePanelIdProp.codec.encode(rowA)}}
      : row)

    setHash('#ws-1/b') // Back landed on b
    const pending = projection.applyCurrentUrl()
    deliverRowsEvent(projection, staleRows) // the stale event arrives mid-flight

    // Without suppression this replaces/pushes '#ws-1/a;active', clobbering
    // the Back target before its reconcile runs.
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])

    await pending
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])
    expect(hash()).toBe('#ws-1/b') // Back target survived…
    expect(panelBlockIds(await rows())).toEqual(['b']) // …and was applied

    // Outbound still lives after the drain (the suppression is not sticky).
    await navigatePanel(rowA, 'c')
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatch(/^#ws-1\/c/)
    projection.dispose()
  })

  it('a rows divergence during a pending inbound still projects after the drain', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, setHash} = startProjection('#ws-1/a')
    await projection.start()

    // Inbound for a foreign-workspace hash applies nothing but holds the
    // queue; the concurrent navigate's rows event lands either during the
    // pending window (suppressed → deferred flush) or after it (normal
    // outbound) — both must end in exactly one push of the diverged layout.
    setHash('#other-ws/z')
    const pending = projection.applyCurrentUrl()
    await navigatePanel(rowA, 'c')
    await pending

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/c']))
    projection.dispose()
  })

  it('applies a sublayout hash arriving via the URL subscription without rejecting', async () => {
    await createPanelRows(['a'])
    let currentHash = '#ws-1/a'
    let listener: (() => void) | null = null
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => { currentHash = hash },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: l => {
        listener = l
        return () => {}
      },
    })
    await projection.start()

    currentHash = '#ws-1/(x/y)'
    listener!() // must not produce an unhandled rejection

    await vi.waitFor(async () => {
      expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual(['x', 'y'])
    })
    await vi.waitFor(() => expect(currentHash).toBe('#ws-1/x,y'))
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
