// App is a BOOT SHIM — do not grow it. It owns the first read of the boot
// layout (src/bootstrap/initialLayout.ts), the §6 access gates, the TTI mark, the
// always-on hash watcher, reactive role tracking, and provisioning the
// layout-root seam value (LayoutRootContext). New app-root behavior goes into
// an overridable seam instead — a block renderer (like TopLevelRenderer), a
// facet, or the layout-root hook (usePanelLayoutProjection / LayoutRootContext).
// See docs/perspective-keep-alive-design.html.
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.js'
import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { useSearchParam } from 'react-use'
import { useIsLocalOnly } from '@/components/Login.js'
import { remoteSyncEnabled } from '@/services/powersync.js'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.js'
import { buildAppHash, layoutWorkspaceChanged, parseLayout } from '@/utils/routing.js'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.js'
import { hasSafeModeSearchParam } from '@/utils/safeMode.js'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext.js'
import { WorkspaceKeyGate, workspaceGateDeps } from '@/components/workspace/WorkspaceKeyGate.js'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher.js'
import { WorkspaceSyncGate } from '@/components/workspace/WorkspaceSyncGate.js'
import { useCloseOnServerE2ee } from '@/components/workspace/useCloseOnServerE2ee.js'
import { useCloseOnKeyLoss } from '@/components/workspace/useCloseOnKeyLoss.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { getCurrentHash, getInitialLayout, preparedInitialHash } from '@/bootstrap/initialLayout.js'

// `ready`: the workspace bootstrapped normally. `locked`: the §6 gate
// intercepted before any bootstrap write — the workspace is e2ee without its
// key, never-pinned (quarantine), or e2ee on the server while this device's pin
// isn't — and App renders the WorkspaceKeyGate. `syncing`: this device has not
// caught up on the workspace's first sync, or its row has not arrived so access
// is undecided; App renders the WorkspaceSyncGate, which re-resolves when that
// changes.
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
  const localOnly = useIsLocalOnly()
  const useRemoteSync = remoteSyncEnabled(localOnly)

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

  // Reactive role tracking. resolveInitialLayout sets the flag the first paint
  // has (read-only while gated, the role once ready). This effect handles role
  // changes pushed by the server mid-session — e.g. an owner demoting an editor
  // to viewer while they're online — without requiring a reload.
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const activeRole = rolesByWorkspaceId.get(activeWorkspaceId)
  useEffect(() => {
    // Don't override a gate's read-only lock with the role-derived flag (an
    // owner/editor of a gated workspace must stay read-only).
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
  // when the key gate is resolved.
  // Keeps the snapshot's hash, not the URL's: after `resolveDefaultWorkspace`
  // the URL still names the workspace just left.
  const reResolve = useCallback(() => {
    setHashSnapshot(current => ({hash: current.hash, version: current.version + 1}))
  }, [])
  // Re-resolve as if no workspace were named — the remembered one, else the
  // personal one. For leaving a gated workspace just deleted.
  const resolveDefaultWorkspace = useCallback(() => {
    setHashSnapshot(current => ({hash: '', version: current.version + 1}))
  }, [])
  // Re-resolve the gated workspace BY ID: while gated nothing is remembered and
  // the snapshot hash may be empty, which would resolve through the
  // ensure-personal RPC — a throw offline.
  const openGatedWorkspace = useCallback(() => {
    setHashSnapshot(current => ({
      hash: parseLayout(current.hash).workspaceId === activeWorkspaceId ? current.hash : buildAppHash(activeWorkspaceId),
      version: current.version + 1,
    }))
  }, [activeWorkspaceId])
  // Re-resolve an OPEN workspace at the URL, which projects its current layout.
  // Not `reResolve`: same-workspace navigation never updates the snapshot, so
  // its hash is the layout the workspace opened at.
  const closeOpenWorkspace = useCallback(() => {
    setHashSnapshot(current => ({hash: getCurrentHash(), version: current.version + 1}))
  }, [])

  // A workspace the server converts to e2ee while it's open here closes into
  // the gate: until this device's pin is upgraded it can't sync the workspace.
  useCloseOnServerE2ee(repo.db, repo.user.id, activeWorkspaceId, initial.kind === 'ready', closeOpenWorkspace)
  // So does one whose key this device stops holding: the browser evicted it.
  useCloseOnKeyLoss(repo, initial.kind === 'ready' ? initial : null, closeOpenWorkspace)
  const gateDeps = useMemo(() => workspaceGateDeps(repo, activeWorkspaceId), [repo, activeWorkspaceId])

  if (initial.kind === 'syncing') {
    return (
      <WorkspaceSyncGate
        key={initial.workspaceId}
        workspaceId={initial.workspaceId}
        workspaceName={initial.workspaceName}
        awaitingRow={initial.awaitingRow}
        onReady={openGatedWorkspace}
        footer={<WorkspaceSwitcher gate={{workspaceId: initial.workspaceId, onLeave: resolveDefaultWorkspace}}/>}
      />
    )
  }

  if (initial.kind === 'locked') {
    return (
      <WorkspaceKeyGate
        // One instance per workspace: a hash change between two locked
        // workspaces must not carry one gate's state into the other's.
        key={initial.workspaceId}
        userId={repo.user.id}
        workspaceId={initial.workspaceId}
        workspaceName={initial.workspaceName ?? undefined}
        reason={initial.reason}
        canary={initial.canary}
        // The gate drains the now-decryptable staged rows before this
        // re-resolve; re-entry mid-drain (footer, Back) lands in the sync gate,
        // which holds bootstrap until the drain has applied them.
        deps={gateDeps}
        onResolved={reResolve}
        footer={<WorkspaceSwitcher gate={{workspaceId: initial.workspaceId, onLeave: resolveDefaultWorkspace}}/>}
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

export default App
