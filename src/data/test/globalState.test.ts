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
 *   - getLayoutSessionBlock: ensures ui-state/layout-sessions/{layoutSessionId}
 *   - getSelectionStateSnapshot: returns peekProperty value, defaults
 *     to the schema default when absent
 *   - resetBlockSelection: no-op when already empty, clears when set
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'
import { PAGE_TYPE } from '@/data/blockTypes'
import {
  aliasesProp,
  selectionStateProp,
  typesProp,
} from '@/data/properties'
import {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getSelectionStateSnapshot,
  getUIStateBlock,
  getUserBlock,
  getUserPrefsBlock,
  resetBlockSelection,
} from '@/data/stateBlocks'
import { defineBlockType } from '@/data/api'

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
    expect(userBlock.peekProperty(typesProp)).toEqual([PAGE_TYPE])

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
      expect(restored.peekProperty(typesProp)).toEqual([PAGE_TYPE])
    } finally {
      await fresh.h.cleanup()
    }
  })
})

describe('getUserPrefsBlock', () => {
  it('ensures the "Preferences" child under the user page', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const prefs = await getUserPrefsBlock(env.repo, WS, USER)

    expect(prefs.peek()?.parentId).toBe(userBlock.id)
    expect(prefs.peek()?.content).toBe('Preferences')
    // No type marker on the root Preferences container — it's just a
    // structural parent for per-plugin prefs sub-blocks.
    expect(prefs.peekProperty(typesProp)).toBeUndefined()

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
      expect(prefs.peek()?.content).toBe('Preferences')

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

describe('getPluginPrefsBlock', () => {
  const examplePrefsType = defineBlockType({
    id: 'example-plugin-prefs',
    label: 'Example plugin prefs',
  })

  it('ensures a sub-block under user-prefs keyed by the type id, titled by the label', async () => {
    const userPrefs = await getUserPrefsBlock(env.repo, WS, USER)
    const pluginPrefs = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)

    expect(pluginPrefs.peek()?.parentId).toBe(userPrefs.id)
    expect(pluginPrefs.peek()?.content).toBe('Example plugin prefs')
    expect(pluginPrefs.peekProperty(typesProp)).toEqual(['example-plugin-prefs'])
  })

  it('falls back to the type id when the contribution omits a label', async () => {
    const otherEnv = await setup()
    try {
      const unlabeled = defineBlockType({id: 'unlabeled-plugin-prefs'})
      const block = await getPluginPrefsBlock(otherEnv.repo, WS, USER, unlabeled)
      expect(block.peek()?.content).toBe('unlabeled-plugin-prefs')
    } finally {
      await otherEnv.h.cleanup()
    }
  })

  it('is idempotent — same type resolves to the same block', async () => {
    const a = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const b = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    expect(a).toBe(b)
  })

  it('isolates distinct plugin prefs into distinct sub-blocks', async () => {
    const otherType = defineBlockType({id: 'other-plugin-prefs'})
    const a = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const b = await getPluginPrefsBlock(env.repo, WS, USER, otherType)

    expect(a.id).not.toBe(b.id)
    expect(a.peek()?.parentId).toBe(b.peek()?.parentId)
    expect(a.peekProperty(typesProp)).toEqual(['example-plugin-prefs'])
    expect(b.peekProperty(typesProp)).toEqual(['other-plugin-prefs'])
  })

  it('routes its bootstrap write through ChangeScope.UserPrefs', async () => {
    await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user', workspace_id: WS})
  })
})

describe('getPluginUIStateBlock', () => {
  const exampleUIStateType = defineBlockType({
    id: 'example-plugin-ui-state',
    label: 'Example plugin state',
  })

  it('ensures a sub-block under root ui-state titled by the label', async () => {
    const rootUI = await getUIStateBlock(env.repo, WS, USER, {})
    const pluginUI = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)

    expect(pluginUI.peek()?.parentId).toBe(rootUI.id)
    expect(pluginUI.peek()?.content).toBe('Example plugin state')
    expect(pluginUI.peekProperty(typesProp)).toEqual(['example-plugin-ui-state'])
  })

  it('is idempotent — same type resolves to the same block', async () => {
    const a = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    const b = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    expect(a).toBe(b)
  })

  it('routes its bootstrap write through ChangeScope.UiState (local-ephemeral)', async () => {
    const pluginUI = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    // Bootstrap should not enter the upload queue: ui-state writes are
    // local-ephemeral. (Earlier UserPrefs bootstraps for the user page do
    // populate ps_crud — we only assert the plugin-ui-state row itself
    // never enters that queue.)
    expect(events.at(-1)).toEqual({scope: ChangeScope.UiState, source: 'local-ephemeral'})
    const crudForBlock = await env.h.db.getAll<{id: string}>(
      "SELECT id FROM ps_crud WHERE data LIKE '%' || ? || '%'",
      [pluginUI.id],
    )
    expect(crudForBlock).toEqual([])
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

describe('getLayoutSessionBlock', () => {
  it('ensures a layout-session-specific child under ui-state/layout-sessions', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(uiState, 'layout-session-a')

    expect(layoutSession.peek()?.content).toBe('layout-session-a')

    const layoutSessionsParent = layoutSession.parent
    expect(layoutSessionsParent?.peek()?.parentId).toBe(uiState.id)
    expect(layoutSessionsParent?.peek()?.content).toBe('layout-sessions')
  })

  it('is idempotent for the same layoutSessionId', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const a = await getLayoutSessionBlock(uiState, 'layout-session-a')
    const b = await getLayoutSessionBlock(uiState, 'layout-session-a')
    expect(a).toBe(b)
  })

  it('keeps different layoutSessionIds in independent layout session blocks', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const a = await getLayoutSessionBlock(uiState, 'layout-session-a')
    const b = await getLayoutSessionBlock(uiState, 'layout-session-b')

    expect(a.id).not.toBe(b.id)
    expect(a.peek()?.parentId).toBe(b.peek()?.parentId)
    expect(a.peek()?.content).toBe('layout-session-a')
    expect(b.peek()?.content).toBe('layout-session-b')
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
