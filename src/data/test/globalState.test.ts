// @vitest-environment node
/**
 * Non-hook helpers from `src/data/globalState.ts` — the durable
 * domain-side bits of the per-user "user page", user prefs, and per-panel ui-state
 * subtree. The React hooks defined alongside these helpers are NOT
 * tested here (Phase 2 rewrites them on `useHandle` + Suspense), but
 * the resolvers / mutators stay.
 *
 * Coverage:
 *   - getUserBlock: creates a parent-less user page with the user's
 *     display name as content + alias; deterministic id per
 *     (workspace, user); idempotent (memoized — second call returns
 *     same promise + Block); falls back to user.id when name is
 *     undefined; restores tombstoned user page
 *   - getUserPrefsBlock: ensures the synced user-prefs child
 *   - getUIStateBlock(repo, ws, user, ctx): with panelId → returns
 *     the panel block; without panelId → ensures a 'ui-state' child
 *     of the user page
 *   - getPanelsBlock: ensures a 'panels' child of the ui-state
 *   - isMainPanel: content === 'main'
 *   - getSelectionStateSnapshot: returns peekProperty value, defaults
 *     to the schema default when absent
 *   - resetBlockSelection: no-op when already empty, clears when set
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'
import {
  aliasesProp,
  selectionStateProp,
} from '@/data/properties'
import {
  MAIN_PANEL_NAME,
  getPanelsBlock,
  getSelectionStateSnapshot,
  getUIStateBlock,
  getUserBlock,
  getUserPrefsBlock,
  isMainPanel,
  resetBlockSelection,
} from '@/data/globalState'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: USER,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('getUserBlock', () => {
  it('creates a parent-less user page with content + alias from user.name', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const data = userBlock.peek()

    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe('Alice')
    expect(userBlock.peekProperty(aliasesProp)).toEqual(['Alice'])

    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user'})
  })

  it('uses a deterministic id stable per (workspace, user)', async () => {
    const a = await getUserBlock(env.repo, WS, USER)
    const b = await getUserBlock(env.repo, WS, USER)
    expect(a.id).toBe(b.id)
    expect(a).toBe(b)  // identity-stable Block + memoized promise
  })

  it('falls back to user.id when user.name is undefined', async () => {
    const otherEnv = await setup()
    try {
      const noNameUser: User = {id: 'user-no-name'}
      const block = await getUserBlock(otherEnv.repo, WS, noNameUser)
      expect(block.peek()?.content).toBe('user-no-name')
      expect(block.peekProperty(aliasesProp)).toEqual(['user-no-name'])
    } finally {
      await otherEnv.h.cleanup()
    }
  })

  it('restores a tombstoned user page', async () => {
    const block = await getUserBlock(env.repo, WS, USER)
    await env.repo.tx(tx => tx.delete(block.id), {scope: ChangeScope.UserPrefs})

    // Re-resolve via a fresh Repo so we bypass the lodash.memoize
    // cached promise (which would short-circuit and never enter the
    // restore branch). New Repo instance = new memoize key.
    const fresh = await setup()
    try {
      const restored = await getUserBlock(fresh.repo, WS, USER)
      expect(restored.id).toBe(block.id)
      // Pull current data from SQL via the fresh repo's cache.
      await fresh.repo.load(restored.id)
      expect(restored.peek()?.deleted).toBe(false)
      expect(restored.peekProperty(aliasesProp)).toEqual(['Alice'])
    } finally {
      await fresh.h.cleanup()
    }
  })
})

describe('getUserPrefsBlock', () => {
  it('ensures a "user-prefs" child under the user page', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const prefs = await getUserPrefsBlock(env.repo, WS, USER)

    expect(prefs.peek()?.parentId).toBe(userBlock.id)
    expect(prefs.peek()?.content).toBe('user-prefs')

    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user', workspace_id: WS})
  })

  it('routes to local-ephemeral in read-only repos', async () => {
    const h = await createTestDb()
    const repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: USER,
      isReadOnly: true,
      registerKernelProcessors: false,
    })
    repo.setActiveWorkspaceId(WS)

    try {
      const prefs = await getUserPrefsBlock(repo, WS, USER)
      expect(prefs.peek()?.content).toBe('user-prefs')

      const events = await h.db.getAll<{scope: string; source: string}>(
        'SELECT scope, source FROM command_events ORDER BY created_at',
      )
      expect(events.every(event => event.scope === ChangeScope.UserPrefs)).toBe(true)
      expect(events.every(event => event.source === 'local-ephemeral')).toBe(true)
      expect(await h.db.getAll('SELECT id FROM ps_crud')).toEqual([])
    } finally {
      await h.cleanup()
    }
  })
})

describe('getUIStateBlock', () => {
  it('with panelId: returns the panel block directly', async () => {
    // Pre-create a "panel block" the test can hand to the resolver.
    const PANEL_ID = 'panel-1'
    await env.repo.tx(tx => tx.create({
      id: PANEL_ID,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'main',
    }), {scope: ChangeScope.BlockDefault})

    const block = await getUIStateBlock(env.repo, WS, USER, {panelId: PANEL_ID})
    expect(block.id).toBe(PANEL_ID)
  })

  it('without panelId: ensures a ui-state child of the user page', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})

    expect(uiState.peek()?.parentId).toBe(userBlock.id)
    expect(uiState.peek()?.content).toBe('ui-state')

    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UiState, source: 'local-ephemeral', workspace_id: WS})
  })

  it('without panelId: idempotent — second call returns the same Block', async () => {
    const a = await getUIStateBlock(env.repo, WS, USER, {})
    const b = await getUIStateBlock(env.repo, WS, USER, {})
    expect(a).toBe(b)
  })
})

describe('getPanelsBlock', () => {
  it('ensures a "panels" child under the ui-state block', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const panels = await getPanelsBlock(uiState)

    expect(panels.peek()?.parentId).toBe(uiState.id)
    expect(panels.peek()?.content).toBe('panels')
  })

  it('is idempotent', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const a = await getPanelsBlock(uiState)
    const b = await getPanelsBlock(uiState)
    expect(a).toBe(b)
  })
})

describe('isMainPanel', () => {
  it('returns true for a block with content="main"', async () => {
    await env.repo.tx(tx => tx.create({
      id: 'p1', workspaceId: WS, parentId: null, orderKey: 'a0', content: MAIN_PANEL_NAME,
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.load('p1')
    expect(isMainPanel(env.repo.block('p1'))).toBe(true)
  })

  it('returns false for any other content', async () => {
    await env.repo.tx(tx => tx.create({
      id: 'p2', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'sidebar',
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.load('p2')
    expect(isMainPanel(env.repo.block('p2'))).toBe(false)
  })
})

describe('getSelectionStateSnapshot', () => {
  it('returns the schema default when no selection is stored', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    expect(getSelectionStateSnapshot(uiState)).toEqual(selectionStateProp.defaultValue)
  })

  it('returns the stored selection state when present', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    await uiState.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })
    expect(getSelectionStateSnapshot(uiState)).toEqual({
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })
  })
})

describe('resetBlockSelection', () => {
  it('is a no-op when selection is already empty', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const before = uiState.peekProperty(selectionStateProp)

    await resetBlockSelection(uiState)
    const after = uiState.peekProperty(selectionStateProp)
    expect(after).toEqual(before)
  })

  it('clears non-empty selection (selected ids + anchor)', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    await uiState.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })

    await resetBlockSelection(uiState)
    expect(uiState.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: [],
      anchorBlockId: null,
    })
  })
})
