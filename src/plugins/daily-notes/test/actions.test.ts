// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import {
  activePanelIdProp,
  editorSelection,
  isEditingProp,
  peekFocusedBlockLocation,
  topLevelBlockIdProp,
} from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  isPanelStackRow,
  layoutSlotsFromRows,
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection'
import {
  dailyNotesActions,
} from '../actions.ts'
import {
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '../index.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    extensions: [dailyNotesDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 4, 13, 12))
  env = await setup()
})

afterEach(async () => {
  vi.useRealTimers()
})

describe('dailyNotesActions', () => {
  it('appends an empty block to today and opens it in an editing stacked panel', async () => {
    const daily = await getOrCreateDailyNote(env.repo, WS, '2026-05-13')
    await env.repo.mutate.createChild({
      id: 'existing-daily-child',
      parentId: daily.id,
      content: 'existing',
    })
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'main-block',
        workspaceId: WS,
        parentId: null,
        orderKey: 'm0',
        content: 'Main',
      })
    }, {scope: ChangeScope.BlockDefault})

    const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
    await insertPanelRow(env.repo, layoutSession, 'main-block')

    const action = dailyNotesActions({repo: env.repo})
      .find(candidate => candidate.id === 'append_today_daily_block')
    expect(action).toBeDefined()

    await action!.handler(
      {uiStateBlock: rootUiState},
      {preventDefault: vi.fn()} as unknown as KeyboardEvent,
    )

    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren[0]).toBe('existing-daily-child')
    expect(dailyChildren).toHaveLength(2)
    const newBlockId = dailyChildren[1]
    expect(env.repo.block(newBlockId).peek()?.content).toBe('')

    const layoutRows = await env.repo.query.subtree({id: layoutSession.id}).load()
    // The slot projection collapses a singleton stack to its leaf, so the
    // stacked placement is asserted structurally below (the new panel row's
    // parent is a panel-stack row), not via the slot shape.
    expect(layoutSlotsFromRows(layoutSession.id, layoutRows)).toEqual([
      {kind: 'leaf', blockId: 'main-block'},
      // The action activates the new stacked panel (activePanelIdProp is
      // asserted directly below), so its slot carries the active flag.
      {kind: 'leaf', blockId: newBlockId, active: true},
    ])

    const newPanel = panelRowsInLayoutOrder(layoutSession.id, layoutRows)
      .find(row => panelBlockId(row) === newBlockId)
    expect(newPanel).toBeTruthy()
    const newPanelParent = layoutRows.find(row => row.id === newPanel!.parentId)
    expect(newPanelParent && isPanelStackRow(newPanelParent)).toBe(true)
    await env.repo.block(newPanel!.id).load()
    await layoutSession.load()

    expect(env.repo.block(newPanel!.id).peekProperty(topLevelBlockIdProp)).toBe(newBlockId)
    expect(peekFocusedBlockLocation(env.repo.block(newPanel!.id))?.blockId).toBe(newBlockId)
    expect(env.repo.block(newPanel!.id).peekProperty(editorSelection)).toEqual({
      blockId: newBlockId,
      start: 0,
    })
    expect(env.repo.block(newPanel!.id).peekProperty(isEditingProp)).toBe(true)
    expect(layoutSession.peekProperty(activePanelIdProp)).toBe(newPanel!.id)
  })
})
