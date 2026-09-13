// App is a BOOT SHIM — do not grow it. It owns workspace resolution
// (getInitialLayout + its cache), the §6 access gates, the TTI mark, the
// always-on hash watcher, reactive role tracking, and provisioning the
// layout-root seam value (LayoutRootContext). New app-root behavior goes into
// an overridable seam instead — a block renderer (like TopLevelRenderer), a
// facet, or the layout-root hook (usePanelLayoutProjection / LayoutRootContext).
// See docs/perspective-keep-alive-design.html.
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.js'
import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@powersync/react'
import { useRepo } from '@/context/repo.js'
import { useSearchParam } from 'react-use'
import { hasRemoteSyncConfig } from '@/services/powersync.js'
import { useIsLocalOnly } from '@/components/Login.js'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.js'
import { layoutWorkspaceChanged } from '@/utils/routing.js'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.js'
import { hasSafeModeSearchParam } from '@/utils/safeMode.js'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext.js'
import { WorkspaceKeyGate } from '@/components/workspace/WorkspaceKeyGate.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { getCurrentHash, getInitialLayout, preparedInitialHash } from '@/bootstrap/initialLayout.js'

// `ready`: the workspace materialized and bootstrapped normally. `locked`: the
// §6 gate intercepted before any bootstrap write — the workspace is e2ee
// without its key, or never-pinned (quarantine) — and App renders the
// WorkspaceKeyGate. `waiting`: access can't be decided until the workspaces row
// replicates (opened by URL before sync delivered encryption_mode/wk_canary);
// App shows a neutral loader and re-resolves when the row lands.
interface HashSnapshot {
  hash: string
  version: number
}

const App = () => {
  const repo = useRepo()
  const [hashSnapshot, setHashSnapshot] = useState<HashSnapshot>(() => ({
    hash: preparedInitialHash(repo) ?? getCurrentHash(),
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
      inner = requestAnimationFrame(() => {
        markStartup('firstContentPaint')
        // Warm the dynamic-extension Tailwind safelist now that first paint
        // is done — extensions can't run before the DB opens anyway, so this
        // is never on the critical path, but starting it here (rather than
        // waiting for the first extension to load) keeps it ready in time.
      })
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
