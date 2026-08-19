// @vitest-environment node
/**
 * Pins the per-pane render-scope FALLBACKS: when a handler runs
 * without an ambient rendered scope (deps.renderScopeId undefined), the
 * written focus location must still land in the pane's scope namespace —
 * `uiStateRenderScopeId` derives it from the ui-state block (panel rows are
 * the only carriers of `topLevelBlockIdProp`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  peekFocusedBlockLocation,
  selectionStateProp,
  topLevelBlockIdProp,
  uiStateRenderScopeId,
} from '@/data/properties'
import { outlineRenderScopeId, panelRenderScopeId } from '@/utils/renderScope'
import { extendSelection } from '@/utils/selection'
import { getVimNormalModeActions } from '../actions.ts'
import type { BlockShortcutDependencies } from '@/shortcuts/types'
import type { ActionTrigger } from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const PANEL_UI = 'panel-ui'
const ROOT = 'root'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
    await tx.create({id: 'c0', workspaceId: WS, parentId: ROOT, orderKey: 'a0', content: 'c0'})
    await tx.create({id: 'c1', workspaceId: WS, parentId: ROOT, orderKey: 'a1', content: 'c1'})
    // Panel-shaped ui-state block: carries topLevelBlockIdProp.
    await tx.create({
      id: PANEL_UI,
      workspaceId: WS,
      parentId: null,
      orderKey: 'z0',
      content: 'Panel UI',
      properties: {
        [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(ROOT),
      },
    })
    // Non-panel ui-state block: no topLevelBlockIdProp.
    await tx.create({id: 'plain-ui', workspaceId: WS, parentId: null, orderKey: 'z1', content: 'Plain UI'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed scope-fallback fixture'})
  await repo.load(PANEL_UI)
  await repo.load('plain-ui')
})

const deps = (overrides: Partial<BlockShortcutDependencies> = {}): BlockShortcutDependencies => ({
  uiStateBlock: repo.block(PANEL_UI),
  scopeRootId: ROOT,
  block: repo.block('c0'),
  renderScopeId: undefined, // no ambient rendered scope — the fallback path
  ...overrides,
} as BlockShortcutDependencies)

const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

describe('per-pane scope fallbacks (no ambient renderScopeId)', () => {
  it('jump_to_first_visible_block writes the per-pane scope', async () => {
    const action = getVimNormalModeActions({repo}).find(a => a.id === 'jump_to_first_visible_block')
    if (!action) throw new Error('missing jump_to_first_visible_block')

    await action.handler(deps(), trigger)

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(repo.block(PANEL_UI))).toEqual({
        blockId: ROOT,
        renderScopeId: panelRenderScopeId(PANEL_UI, ROOT),
      })
    })
  })

  it('jump_to_last_visible_block writes the per-pane scope', async () => {
    const action = getVimNormalModeActions({repo}).find(a => a.id === 'jump_to_last_visible_block')
    if (!action) throw new Error('missing jump_to_last_visible_block')

    await action.handler(deps(), trigger)

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(repo.block(PANEL_UI))).toEqual({
        blockId: 'c1',
        renderScopeId: panelRenderScopeId(PANEL_UI, ROOT),
      })
    })
  })

  it('extendSelection with no ambient scope writes the per-pane scope', async () => {
    // Anchor comes from selection state; no focus location exists, so the
    // target location's scope goes through the uiStateRenderScopeId fallback.
    await repo.block(PANEL_UI).set(selectionStateProp, {
      selectedBlockIds: ['c0'],
      anchorBlockId: 'c0',
    })

    const extended = await extendSelection('c1', repo.block(PANEL_UI), repo, ROOT)

    expect(extended).toBe(true)
    expect(peekFocusedBlockLocation(repo.block(PANEL_UI))).toEqual({
      blockId: 'c1',
      renderScopeId: panelRenderScopeId(PANEL_UI, ROOT),
    })
  })

  it('uiStateRenderScopeId falls back to the outline scope for non-panel ui-state', () => {
    expect(uiStateRenderScopeId(repo.block('plain-ui'), 'some-block'))
      .toBe(outlineRenderScopeId('some-block'))
  })
})
