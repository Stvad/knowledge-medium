// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { getPerTabBlock, getUIStateBlock } from '@/data/globalState'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { keysBetween } from '@/data/orderKey'
import {
  focusedBlockIdProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import {
  PanelLayoutProjection,
  applyCurrentLayoutUrl,
  createPanelRowInTx,
  panelBlockIds,
} from '@/utils/panelLayoutProjection'
import { panelHistory } from '@/utils/panelHistory'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  perTabBlockId: string
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const perTabBlock = await getPerTabBlock(uiState, 'tab-a')
  return {h, repo, perTabBlockId: perTabBlock.id}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const perTabBlock = () => env.repo.block(env.perTabBlockId)

const createPanelRows = async (blockIds: readonly string[]): Promise<void> => {
  const parent = perTabBlock()
  await env.repo.tx(async tx => {
    const parentData = await tx.get(parent.id)
    if (!parentData) throw new Error('missing per-tab block')
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

const rows = async () => perTabBlock().children.load()

const rowIdsByBlock = async (): Promise<Map<string, string>> =>
  new Map((await rows()).map(row => [row.properties[topLevelBlockIdProp.name] as string, row.id]))

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('applyCurrentLayoutUrl', () => {
  it('creates panel rows for an explicit layout URL', async () => {
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      hash: '#ws-1/a/b',
    })

    expect(result.kind).toBe('applied')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('inserts in the middle while preserving surviving row ids', async () => {
    await createPanelRows(['a', 'c'])
    const before = await rowIdsByBlock()

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
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
      state: {focusedBlockId: 'x-child', scrollTop: 42},
    })

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      hash: '#ws-1/a/x',
    })

    const after = await rowIdsByBlock()
    expect(after.get('x')).toBe(rowB)
    expect(env.repo.block(rowB).peekProperty(focusedBlockIdProp)).toBe('x-child')
    expect(panelHistory.consumeRestore(rowB)).toEqual({focusedBlockId: 'x-child', scrollTop: 42})
    expect(panelHistory.getSnapshot(rowB).forward.map(entry => entry.blockId)).toEqual(['b'])
  })

  it('preserves row ids when the URL reorders existing panels', async () => {
    await createPanelRows(['a', 'b', 'c'])
    const before = await rowIdsByBlock()

    await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      hash: '#ws-1/c/a/b',
    })

    const after = await rowIdsByBlock()
    expect(panelBlockIds(await rows())).toEqual(['c', 'a', 'b'])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('b')).toBe(before.get('b'))
    expect(after.get('c')).toBe(before.get('c'))
  })

  it('normalizes a bare workspace URL to existing tab rows without writing rows', async () => {
    await createPanelRows(['a', 'b'])
    let replaced = ''

    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      hash: '#ws-1',
      replaceHash: hash => { replaced = hash },
    })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('ignores URLs for another workspace', async () => {
    const result = await applyCurrentLayoutUrl({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      hash: '#other/a',
    })

    expect(result.kind).toBe('ignored')
    expect(panelBlockIds(await rows())).toEqual([])
  })
})

describe('PanelLayoutProjection', () => {
  it('pushes a URL when subscribed panel rows change', async () => {
    await createPanelRows(['a'])
    let currentHash = '#ws-1/a'
    let pushed = ''
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      perTabBlock: perTabBlock(),
      getHash: () => currentHash,
      pushHash: hash => {
        pushed = hash
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    await projection.start()

    const [row] = await rows()
    await env.repo.tx(async tx => {
      await tx.setProperty(row.id, topLevelBlockIdProp, 'b')
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})

    await waitFor(() => pushed === '#ws-1/b')
    projection.dispose()
  })
})
