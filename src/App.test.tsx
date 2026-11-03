// @vitest-environment happy-dom

import { Suspense } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext'

// App's ready path fans out through workspace resolution, the §6 access
// gate, and the bootstrap-write phase — each its own module with its own
// (Supabase/PowerSync/IndexedDB-touching) dependencies. None of that is what
// this test is pinning: it's pinning that App, once it resolves a `ready`
// layout, still wraps the tree in `LayoutRootContext.Provider` with the
// resolved root block id and a working cache-bust callback — the other half
// of the seam TopLevelRenderer.test.tsx pins from the renderer side. So every
// collaborator on the path to `ready` is replaced with a trivial stand-in;
// only App's own composition (this file) and the context module (real,
// unmocked) are under test.

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const FAKE_LAYOUT_BLOCK_ID = 'layout-session-fake'

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/bootstrap/resolveWorkspace.js', () => ({
  resolveWorkspace: vi.fn(async () => ({id: 'ws-1', freshlyCreated: false})),
}))

vi.mock('@/data/workspaces.js', async () => {
  const actual = await vi.importActual<typeof import('@/data/workspaces.js')>('@/data/workspaces.js')
  return {
    ...actual,
    getLocalMemberRole: vi.fn(async () => 'owner'),
    getLocalWorkspace: vi.fn(async () => null),
  }
})

vi.mock('@/sync/keys/resolveWorkspaceEntry.js', () => ({
  resolveWorkspaceEntry: vi.fn(async () => ({kind: 'ready'})),
}))

vi.mock('@/bootstrap/workspaceBootstrap.js', () => ({
  bootstrapWorkspace: vi.fn(async () => ({id: FAKE_LAYOUT_BLOCK_ID} as unknown as Block)),
}))

vi.mock('@/hooks/useWorkspaces.js', () => ({
  useMyWorkspaceRoles: () => ({rolesByWorkspaceId: new Map(), isLoading: false}),
}))

vi.mock('@/components/Login.js', () => ({
  useIsLocalOnly: () => true,
}))

vi.mock('react-use', () => ({
  useSearchParam: () => null,
}))

// The gate's footer switcher reads the workspace list, which this file doesn't
// mock; the stand-in records the `gate` App hands it.
const switcher = vi.hoisted(() => ({
  gate: undefined as import('@/components/workspace/WorkspaceSwitcher').SwitcherGate | undefined,
}))

vi.mock('@/components/workspace/WorkspaceSwitcher.js', () => ({
  WorkspaceSwitcher: ({gate}: {gate?: import('@/components/workspace/WorkspaceSwitcher').SwitcherGate}) => {
    switcher.gate = gate
    return null
  },
}))

// AppRuntimeProvider pulls in the full extension-resolution machinery
// (staticAppExtensions, dynamic-extension loading, localStorage-backed
// overrides). That's the exact kind of thing this test isn't about — swap it
// for a passthrough so only App's own provider composition is exercised.
vi.mock('@/extensions/AppRuntimeProvider.js', () => ({
  AppRuntimeProvider: ({children}: {children: React.ReactNode}) => children,
}))

// Stand in for the (unrelated) renderer-resolution chain BlockComponent
// normally kicks off, and use it as the probe: it reads LayoutRootContext
// exactly like the real TopLevelRenderer would, so its rendered output shows
// what App actually put into the provider.
vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useContext} = await vi.importActual<typeof import('react')>('react')
  return {
    BlockComponent: ({blockId}: {blockId: string}) => {
      // References the module-scope `LayoutRootContext` import below — safe
      // because this factory only runs once `App` (and therefore this mock)
      // is actually imported, by which point that import has resolved.
      const layoutRoot = useContext(LayoutRootContext)
      return (
        <div
          data-testid="app-block-component"
          data-block-id={blockId}
          data-root-block-id={layoutRoot?.rootBlockId ?? ''}
          data-has-callback={String(typeof layoutRoot?.onLayoutHashChanged === 'function')}
        />
      )
    },
  }
})

// Imported after the mocks above so it picks up the mocked collaborators.
import App from './App'
import { resolveWorkspaceEntry } from '@/sync/keys/resolveWorkspaceEntry.js'
import { resolveWorkspace } from '@/bootstrap/resolveWorkspace.js'
import { setModePin } from '@/sync/keys/modePin.js'
import { buildAppHash } from '@/utils/routing'

describe('App / LayoutRootContext provision', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
    repoRef.current = repo
    window.location.hash = ''
    vi.mocked(resolveWorkspaceEntry).mockResolvedValue({kind: 'ready'})
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    vi.clearAllMocks()
  })

  it('wraps the ready layout in LayoutRootContext with the resolved root block id and a callback', async () => {
    // `use()` suspends on the initial-layout promise; the resolution must be
    // awaited inside `act` for React to flush the retry (see
    // useUserBlockReactive.test.tsx for the same pattern).
    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <App/>
        </Suspense>,
      )
    })

    const probe = await screen.findByTestId('app-block-component')
    expect(probe.dataset.blockId).toBe(FAKE_LAYOUT_BLOCK_ID)
    // This is the assertion that fails if App stops providing
    // LayoutRootContext (or provides it with the wrong block) — the
    // TopLevelRenderer-side half of the seam (TopLevelRenderer.test.tsx)
    // can't observe that regression on its own since it constructs the
    // context value itself rather than receiving it from App.
    expect(probe.dataset.rootBlockId).toBe(FAKE_LAYOUT_BLOCK_ID)
    expect(probe.dataset.hasCallback).toBe('true')
  })

  it('closes an open plaintext workspace into the gate when the server converts it', async () => {
    window.localStorage.clear()
    setModePin('user-1', 'ws-1', 'plaintext')
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
       VALUES ('ws-1', 'Vault', 'user-1', 1, 1, 'none')`,
    )
    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <App/>
        </Suspense>,
      )
    })
    await screen.findByTestId('app-block-component')

    // The next resolution sees what the real one would for this row.
    vi.mocked(resolveWorkspaceEntry).mockResolvedValue({
      kind: 'locked', reason: 'server-e2ee', workspaceName: 'Vault', canary: 'enc:v1:canary',
    })
    await act(async () => {
      await sharedDb.db.execute(`UPDATE workspaces SET encryption_mode = 'e2ee' WHERE id = 'ws-1'`)
    })

    await vi.waitFor(() => expect(screen.queryByTestId('app-block-component')).toBeNull())
    expect(await screen.findByRole('heading', {name: /vault/i})).toBeInTheDocument()
  })

  it('leaves a gated workspace for the default one, not the workspace the URL names', async () => {
    window.location.hash = buildAppHash('ws-1')
    vi.mocked(resolveWorkspaceEntry).mockResolvedValue({
      kind: 'locked', reason: 'quarantine', workspaceName: 'Vault', canary: null,
    })
    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <App/>
        </Suspense>,
      )
    })
    expect(await screen.findByRole('heading', {name: /vault/i})).toBeInTheDocument()
    expect(switcher.gate?.workspaceId).toBe('ws-1')
    expect(vi.mocked(resolveWorkspace).mock.lastCall?.[1]).toBe('ws-1')

    vi.mocked(resolveWorkspaceEntry).mockResolvedValue({kind: 'ready'})
    await act(async () => switcher.gate!.onLeave())

    expect(await screen.findByTestId('app-block-component')).toBeInTheDocument()
    expect(vi.mocked(resolveWorkspace).mock.lastCall?.[1]).toBeUndefined()
  })
})
