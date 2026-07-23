// App is a BOOT SHIM — do not grow it. It owns workspace resolution
// (getInitialLayout + its cache), the §6 access gates, the TTI mark, the
// always-on hash watcher, reactive role tracking, and provisioning the
// layout-root seam value (LayoutRootContext). New app-root behavior goes into
// an overridable seam instead — a block renderer (like TopLevelRenderer), a
// facet, or the layout-root hook (usePanelLayoutProjection / LayoutRootContext).
// See the perspective keep-alive RFC (PR #357).
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.js'
import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@powersync/react'
import type { Block } from './data/block'
import { useRepo } from '@/context/repo.js'
import { useSearchParam } from 'react-use'
import type { Repo } from './data/repo'
import { hasRemoteSyncConfig } from '@/services/powersync.js'
import { useIsLocalOnly } from '@/components/Login.js'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.js'
import { getLocalMemberRole, getLocalWorkspace } from '@/data/workspaces.js'
import { layoutWorkspaceChanged, parseLayout } from '@/utils/routing.js'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.js'
import { hasSafeModeSearchParam } from '@/utils/safeMode.js'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext.js'
import { resolveWorkspaceEntry } from '@/sync/keys/resolveWorkspaceEntry.js'
import { WorkspaceKeyGate } from '@/components/workspace/WorkspaceKeyGate.js'
import { resolveWorkspace } from '@/bootstrap/resolveWorkspace.js'
import { bootstrapWorkspace } from '@/bootstrap/workspaceBootstrap.js'
import { markStartup } from '@/utils/startupTimeline.js'

// `ready`: the workspace materialized and bootstrapped normally. `locked`: the
// §6 gate intercepted before any bootstrap write — the workspace is e2ee
// without its key, or never-pinned (quarantine) — and App renders the
// WorkspaceKeyGate. `waiting`: access can't be decided until the workspaces row
// replicates (opened by URL before sync delivered encryption_mode/wk_canary);
// App shows a neutral loader and re-resolves when the row lands.
type InitialLayout =
  | {kind: 'ready'; workspaceId: string; layoutSessionBlock: Block}
  | {
      kind: 'locked'
      workspaceId: string
      workspaceName: string | null
      reason: 'key-required' | 'quarantine'
      canary: string | null
    }
  | {kind: 'waiting'; workspaceId: string}

interface HashSnapshot {
  hash: string
  version: number
}

const INITIAL_LAYOUT_CACHE_LIMIT = 64
const initialLayoutCache = new Map<string, Promise<InitialLayout>>()

const getCurrentHash = (): string =>
  typeof window === 'undefined' ? '' : window.location.hash

// The bootstrap pipeline's composing function: it owns the phase ORDERING that
// was previously encoded only in comments. Three extracted phases run in a fixed
// sequence — resolve the workspace, clear the §6 access gate, then run the
// bootstrap writes — because each depends on the last: the gate must decide
// BEFORE any write (those writes would otherwise land plaintext into an
// encrypted-but-locked workspace). First-run seeding now lives in the
// onboarding plugin's landing resolver, invoked from within
// `bootstrapWorkspace`'s landing step.
const resolveInitialLayout = async (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
): Promise<InitialLayout> => {
  const route = parseLayout(requestedHash)

  // Phase 1 — resolve which workspace this run lands on (URL / remembered /
  // ensure-personal / local-only). Pure async; see bootstrap/resolveWorkspace.
  const {id: workspaceId, freshlyCreated} = await resolveWorkspace(
    repo,
    route.workspaceId,
    useRemoteSync,
  )
  repo.setActiveWorkspaceId(workspaceId)

  // Derive read-only from the local membership row. workspace_members rides
  // the same sync stream as workspaces, so for any workspace we just
  // resolved as accessible, the role row is normally already local. Null
  // (membership not yet synced) defaults to read-only=false; if the role
  // is actually 'viewer', the very next sync tick flips us — and any
  // edits attempted in the meantime would be RLS-rejected server-side
  // anyway.
  const role = await getLocalMemberRole(repo, workspaceId, repo.user.id)
  repo.setReadOnly(role === 'viewer')

  // Phase 2 — §6 rule 3 access gate. Resolve whether this workspace can be
  // materialized for us right now BEFORE any bootstrap write below — those
  // writes (daily note, properties/types/recents pages, ui-state) would
  // otherwise write plaintext into an encrypted-but-locked workspace. If it
  // can't, return a `locked`/`waiting` layout and App renders the gate/loader.
  // The read-inputs + decide halves live together in resolveWorkspaceEntry; the
  // local workspace row read is injected to keep that module within sync/keys.
  const entry = await resolveWorkspaceEntry(repo.user.id, workspaceId, id =>
    getLocalWorkspace(repo, id),
  )
  markStartup('workspaceResolved')
  if (entry.kind === 'waiting') {
    // The workspaces row hasn't replicated yet and the pin can't settle access
    // without it. Don't bootstrap (would write plaintext into a possibly-e2ee
    // workspace) and don't gate with a null canary — wait for the row.
    repo.setReadOnly(true)
    return {kind: 'waiting', workspaceId}
  }
  if (entry.kind === 'locked') {
    repo.setReadOnly(true)
    return {
      kind: 'locked',
      workspaceId,
      workspaceName: entry.workspaceName,
      reason: entry.reason,
      canary: entry.canary,
    }
  }

  // Phase 3 — bootstrap writes (remember-as-default, backfills, tutorial, the
  // Properties/Types/Recents pages, ui-state) + URL→layout application. Runs
  // only past the gate; see bootstrap/workspaceBootstrap.
  const layoutSessionBlock = await bootstrapWorkspace({
    repo,
    workspaceId,
    freshlyCreated,
    requestedHash,
    requestedWorkspaceId: route.workspaceId,
  })
  markStartup('bootstrapDone')

  return {kind: 'ready', workspaceId, layoutSessionBlock}
}

const initialLayoutCacheKey = (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
  navigationVersion: number,
): string =>
  [
    repo.instanceId,
    requestedHash || '__empty_hash__',
    useRemoteSync ? 'remote' : 'local',
    navigationVersion,
  ].join(':')

const getInitialLayout = (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
  navigationVersion: number,
): Promise<InitialLayout> => {
  const key = initialLayoutCacheKey(repo, requestedHash, useRemoteSync, navigationVersion)
  const cached = initialLayoutCache.get(key)
  if (cached) {
    initialLayoutCache.delete(key)
    initialLayoutCache.set(key, cached)
    return cached
  }

  const promise = resolveInitialLayout(repo, requestedHash, useRemoteSync)
  initialLayoutCache.set(key, promise)
  if (initialLayoutCache.size > INITIAL_LAYOUT_CACHE_LIMIT) {
    const oldest = initialLayoutCache.keys().next().value
    if (oldest) initialLayoutCache.delete(oldest)
  }
  void promise.catch(() => {
    if (initialLayoutCache.get(key) === promise) initialLayoutCache.delete(key)
  })
  return promise
}

const App = () => {
  const repo = useRepo()
  const [hashSnapshot, setHashSnapshot] = useState<HashSnapshot>(() => ({
    hash: getCurrentHash(),
    version: 0,
  }))
  const safeMode = hasSafeModeSearchParam(useSearchParam('safeMode'))
  // hasRemoteSyncConfig is the build-time signal; localOnly is the runtime
  // override (the user clicked "Use without sync" on the login screen).
  // Both close the door on Supabase RPCs, so AND them together once here.
  const localOnly = useIsLocalOnly()
  const useRemoteSync = hasRemoteSyncConfig && !localOnly

  const initial = use(
    getInitialLayout(repo, hashSnapshot.hash, useRemoteSync, hashSnapshot.version),
  )
  const activeWorkspaceId = initial.workspaceId
  // null while the workspace is locked (gate shown) — there's no layout yet.
  const layoutSessionBlock = initial.kind === 'ready' ? initial.layoutSessionBlock : null

  // The URL⇄layout projection itself lives with the layout-root renderer
  // (usePanelLayoutProjection, called by TopLevelRenderer or an extension
  // override). App only supplies the seam value: which block is the root, and
  // the cache-bust callback the projection must invoke on layout hash changes
  // (so a projected workspace change re-resolves the initial layout).
  const onLayoutHashChanged = useCallback(() => {
    const nextHash = getCurrentHash()
    setHashSnapshot(current => {
      if (!layoutWorkspaceChanged(current.hash, nextHash)) return current
      return {hash: nextHash, version: current.version + 1}
    })
  }, [])
  const layoutRootContextValue = useMemo(
    () =>
      layoutSessionBlock
        ? {rootBlockId: layoutSessionBlock.id, onLayoutHashChanged}
        : null,
    [layoutSessionBlock, onLayoutHashChanged],
  )

  // Reactive role tracking. The imperative setReadOnly inside
  // resolveWorkspace handles the *initial* render (so the first paint
  // already has the right flag). This effect handles role changes pushed by
  // the server mid-session — e.g. an owner demoting an editor to viewer
  // while they're online — without requiring a reload.
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const activeRole = rolesByWorkspaceId.get(activeWorkspaceId)
  useEffect(() => {
    // Don't override the gate/waiting read-only lock with the role-derived flag
    // (an owner/editor of a *locked* workspace must stay read-only).
    if (initial.kind !== 'ready' || !activeRole) return
    repo.setReadOnly(activeRole === 'viewer')
  }, [initial.kind, activeRole, repo])

  // TTI: stamp the first paint of the actual workspace layout (not a gate /
  // loading screen). A double rAF lands the mark after the browser has painted
  // the committed content; markStartup is first-write-wins, so later re-renders
  // (hash changes, role updates) don't move it.
  useEffect(() => {
    if (initial.kind !== 'ready') return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => markStartup('firstContentPaint'))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [initial.kind])

  // Always watch the URL hash so navigating to a different workspace (Back
  // button / manual hash edit) re-resolves the layout — even while a gate or
  // loading screen is shown. In those states there's no layout, so the
  // projection effect above is inactive and isn't registering the hashchange
  // listener; without this a user who opened a locked workspace would be stuck
  // until a full reload. Safe to run alongside the projection's own listener
  // when ready: the reducer only bumps on a workspace change, so the second
  // handler in a batch sees the already-updated hash and no-ops.
  useEffect(() => {
    const onHashChange = () => {
      const nextHash = getCurrentHash()
      setHashSnapshot(current =>
        layoutWorkspaceChanged(current.hash, nextHash)
          ? {hash: nextHash, version: current.version + 1}
          : current,
      )
    }
    window.addEventListener('hashchange', onHashChange)
    window.addEventListener('popstate', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      window.removeEventListener('popstate', onHashChange)
    }
  }, [])

  // Re-resolve the initial layout (bumping the version busts the cache) — used
  // when a gate is resolved or a pending workspace row finally replicates.
  const reResolve = useCallback(() => {
    setHashSnapshot(current => ({hash: current.hash, version: current.version + 1}))
  }, [])

  if (initial.kind === 'waiting') {
    return <WorkspaceSyncWaiting workspaceId={initial.workspaceId} onReady={reResolve}/>
  }

  if (initial.kind === 'locked') {
    return (
      <WorkspaceKeyGate
        userId={repo.user.id}
        workspaceId={initial.workspaceId}
        workspaceName={initial.workspaceName ?? undefined}
        reason={initial.reason}
        canary={initial.canary}
        onResolved={async () => {
          // Re-materialize the now-decryptable staged rows BEFORE re-resolving,
          // so the bootstrap getOrCreate*s no-op against the synced content
          // rather than racing it.
          await repo.drainSyncWorkspace(initial.workspaceId)
          reResolve()
        }}
      />
    )
  }

  return (
    <LayoutRootContext.Provider value={layoutRootContextValue}>
      <BlockContextProvider initialValue={{layoutBoundary: true, safeMode}}>
        <AppRuntimeProvider safeMode={safeMode}>
          <BlockComponent blockId={initial.layoutSessionBlock.id}/>
        </AppRuntimeProvider>
      </BlockContextProvider>
    </LayoutRootContext.Provider>
  )
}

// Shown while a workspace's row hasn't replicated yet (opened by URL before
// sync delivered encryption_mode/wk_canary). Reactively watches for the row and
// re-resolves the layout the moment it lands — no bootstrap writes happen until
// then, so we never write plaintext into a workspace that may turn out e2ee.
function WorkspaceSyncWaiting({
  workspaceId,
  onReady,
}: {
  workspaceId: string
  onReady: () => void
}) {
  const {data} = useQuery<{id: string}>(
    'SELECT id FROM workspaces WHERE id = ? LIMIT 1',
    [workspaceId],
  )
  const present = data.length > 0
  useEffect(() => {
    if (present) onReady()
  }, [present, onReady])

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">Loading workspace…</p>
    </div>
  )
}

export default App
