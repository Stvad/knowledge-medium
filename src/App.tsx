import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.js'
import { use, useEffect, useState } from 'react'
import type { Block } from './data/block'
import { useRepo } from '@/context/repo.js'
import { useSearchParam } from 'react-use'
import type { Repo } from './data/repo'
import { hasRemoteSyncConfig } from '@/services/powersync.js'
import { useIsLocalOnly } from '@/components/Login.js'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.js'
import {
  canAccessRemoteWorkspace,
  ensureLocalPersonalWorkspace,
  ensurePersonalWorkspace,
  getLocalMemberRole,
  getLocalWorkspace,
  listLocalWorkspaces,
  primeLocalWorkspaceAndMember,
} from '@/data/workspaces.js'
import {
  buildLayout,
  layoutWorkspaceChanged,
  parseLayout,
  preserveHashQueryParams,
} from '@/utils/routing.js'
import { recallRememberedWorkspace, rememberWorkspace } from '@/utils/lastWorkspace.js'
import { seedTutorial } from '@/initData.js'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage.js'
import { getOrCreateTypesPage } from '@/data/typesPage.js'
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.js'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { workspaceLandingFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import {
  PanelLayoutProjection,
  applyCurrentLayoutUrl,
  createPanelRowInTx,
} from '@/utils/panelLayoutProjection.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { ChangeScope } from '@/data/api'
import { hasSafeModeSearchParam } from '@/utils/safeMode.js'

// Resolved-workspace bundle. `freshlyCreated` is true only when this run
// inserted a brand-new personal workspace via ensure_personal_workspace;
// the caller uses it to install the starter tutorial alongside today's
// daily note. Any path that returned an existing workspace (URL nav,
// remembered, RPC returned an already-existing row) leaves it false —
// those workspaces already have whatever pages the user has built up.
interface ResolvedWorkspace {
  id: string
  freshlyCreated: boolean
}

interface InitialLayout {
  workspaceId: string
  layoutSessionBlock: Block
}

interface HashSnapshot {
  hash: string
  version: number
}

const INITIAL_LAYOUT_CACHE_LIMIT = 64
const initialLayoutCache = new Map<string, Promise<InitialLayout>>()

const getCurrentHash = (): string =>
  typeof window === 'undefined' ? '' : window.location.hash

const resolveWorkspace = async (
  repo: Repo,
  requestedWorkspaceId: string | undefined,
  useRemoteSync: boolean,
): Promise<ResolvedWorkspace> => {
  if (requestedWorkspaceId) {
    // Fast path: if PowerSync has already replicated this workspace into
    // our local DB, RLS allowed it — we have access, trust the URL.
    const localWs = await getLocalWorkspace(repo, requestedWorkspaceId)
    if (localWs) return {id: localWs.id, freshlyCreated: false}

    // Slow path: not local. This could be either "we don't have access"
    // or "we have access but sync hasn't replicated yet". Ask the server
    // (RLS-gated) to disambiguate. We can't poll local sqlite for this:
    // `db.waitForFirstSync` resolves instantly on subsequent sessions
    // (persistent IndexedDB), and a missing row could legitimately mean
    // either case.
    if (useRemoteSync) {
      const access = await canAccessRemoteWorkspace(requestedWorkspaceId)
      if (access.kind === 'allowed') {
        // Server confirms access; getInitialLayout will poll for the blocks
        // to land via sync.
        return {id: requestedWorkspaceId, freshlyCreated: false}
      }
      if (access.kind === 'unknown') {
        // Transport-level failure (offline, 5xx, JWT mid-refresh). We don't
        // know if the user has access. Trust the URL hash rather than
        // silently bumping them to a different workspace — the misroute is
        // worse UX than a momentary "no blocks yet" page (which the user
        // can fix with a reload once back online). If they really lack
        // access, the next online bootstrap re-runs this check and falls
        // through cleanly.
        console.warn(
          `canAccessRemoteWorkspace failed for ${requestedWorkspaceId}; trusting URL workspace and proceeding`,
          access.error,
        )
        return {id: requestedWorkspaceId, freshlyCreated: false}
      }
      console.warn(
        `Workspace ${requestedWorkspaceId} from URL is not accessible; falling back to default workspace.`,
      )
    }
    // Confirmed-denied (or no remote sync) — fall through to default flow.
    // The eventual layout normalization will overwrite the bad hash.
  }

  const remembered = recallRememberedWorkspace()
  if (remembered) {
    const ws = await getLocalWorkspace(repo, remembered)
    if (ws) return {id: ws.id, freshlyCreated: false}
  }

  if (useRemoteSync) {
    const result = await ensurePersonalWorkspace()
    // Prime with the canonical member row from the RPC. Priming with a
    // synthetic id (and waiting for sync to deliver the real one) would
    // leave two membership rows in local sqlite, since the raw table has
    // no (workspace_id, user_id) UNIQUE constraint.
    await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)
    return {id: result.workspace.id, freshlyCreated: result.inserted}
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return {id: locals[0].id, freshlyCreated: false}

  // Remote sync disabled (e.g. dev mode without VITE_SUPABASE_*) and
  // nothing local yet: synthesize a deterministic per-user personal
  // workspace + owner membership locally so the rest of bootstrap
  // (seedTutorial, daily note, Tutorial bullet) can run unchanged.
  const local = await ensureLocalPersonalWorkspace(repo)
  return {id: local.workspace.id, freshlyCreated: local.inserted}
}

const replaceHash = (hash: string): void => {
  if (typeof window === 'undefined') return
  const nextHash = preserveHashQueryParams(hash, window.location.hash)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

// Resolve the static-extension runtime once per (repo, workspace).
// `workspaceLandingFacet` resolvers only need the kernel + static
// plugin contributions — dynamic plugins haven't loaded yet at this
// point in bootstrap, and we don't want to give them the power to
// redirect a user's first paint. The cache keeps the cost down across
// re-entries via getInitialLayout's promise cache; entries are bound
// to `repo.instanceId` so a fresh Repo (new login) builds a fresh
// runtime.
const landingRuntimeCache = new Map<number, ReturnType<typeof resolveFacetRuntimeSync>>()
const getLandingRuntime = (repo: Repo) => {
  const cached = landingRuntimeCache.get(repo.instanceId)
  if (cached) return cached
  const runtime = resolveFacetRuntimeSync(staticAppExtensions({repo}), {
    repo,
    workspaceId: repo.activeWorkspaceId,
    safeMode: false,
  })
  landingRuntimeCache.set(repo.instanceId, runtime)
  return runtime
}

// Walk landing resolvers in reverse (highest precedence last in the
// array — see `workspaceLandingFacet` docstring). Return the first
// non-null id, or null if every resolver punts. A throwing resolver
// is logged and skipped so a misbehaving plugin can't permanently
// block the user from booting the app.
const resolveLandingBlockId = async (
  repo: Repo,
  workspaceId: string,
  freshlyCreated: boolean,
): Promise<string | null> => {
  const runtime = getLandingRuntime(repo)
  const resolvers = runtime.read(workspaceLandingFacet)
  for (let i = resolvers.length - 1; i >= 0; i -= 1) {
    try {
      const id = await resolvers[i]({repo, workspaceId, freshlyCreated})
      if (id) return id
    } catch (error) {
      console.error('[App] workspace landing resolver threw', error)
    }
  }
  return null
}

const resolveInitialLayout = async (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
): Promise<InitialLayout> => {
  const route = parseLayout(requestedHash)
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

  rememberWorkspace(workspaceId)

  // Freshly inserted personal workspace: install the starter tutorial
  // as its own parent-less page. The [[Tutorial]] bullet on today's
  // daily note (added below) makes it discoverable from the landing
  // page without hijacking it. AWAIT the seed tx so the Tutorial
  // alias row exists before parseReferences (post-commit processor)
  // runs against the wiki-link bullet — otherwise parseReferences
  // creates a fresh empty alias target for "Tutorial" and the
  // bullet points at that orphan instead of the real seeded page.
  if (freshlyCreated) {
    await seedTutorial(repo, workspaceId)
  }

  // Ensure the Properties page exists (idempotent, deterministic id).
  // User-defined property-schema blocks live under it.
  await getOrCreatePropertiesPage(repo, workspaceId)

  // Ensure the Types page exists (idempotent, deterministic id).
  // User-defined block-type blocks live under it.
  await getOrCreateTypesPage(repo, workspaceId)

  // Ensure the Recents page exists. The recents plugin renders a
  // recently-edited list on it via `repo.query.recentBlocks`.
  await getOrCreateRecentsPage(repo, workspaceId)

  const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
  const layoutSessionBlock = await getLayoutSessionBlock(uiState, getLayoutSessionId())
  const hashForResolvedWorkspace = route.workspaceId && route.workspaceId !== workspaceId
    ? buildLayout(workspaceId)
    : requestedHash

  const applyResult = await applyCurrentLayoutUrl({
    repo,
    workspaceId,
    layoutSessionBlock,
    hash: hashForResolvedWorkspace,
    replaceHash,
  })

  if (applyResult.kind === 'empty') {
    // Empty layout — ask plugins via `workspaceLandingFacet` what block
    // to land on. The daily-notes plugin contributes the historical
    // "open today's note (and seed a [[Tutorial]] bullet on first
    // run)" behavior; other plugins (or none) can override. We resolve
    // the static-extension runtime here SYNCHRONOUSLY rather than
    // waiting for AppRuntimeProvider's full async resolution because
    // the landing decision blocks the first paint — dynamic
    // user-defined plugins shouldn't be able to redirect the bootstrap
    // before we've even built a layout, and the sync runtime carries
    // the same kernel + static plugin contributions
    // AppRuntimeProvider's initial render uses.
    const landingId = await resolveLandingBlockId(repo, workspaceId, freshlyCreated)
    if (landingId) {
      replaceHash(buildLayout(workspaceId, [landingId]))
      await repo.tx(async tx => {
        const parent = await tx.get(layoutSessionBlock.id)
        if (!parent) throw new Error(`getInitialLayout: layout session block ${layoutSessionBlock.id} not found`)
        await createPanelRowInTx(repo, tx, {
          workspaceId,
          parentId: layoutSessionBlock.id,
          orderKey: keyAtEnd(null),
          blockId: landingId,
        })
      }, {scope: ChangeScope.UiState, description: 'bootstrap landing panel'})
    }
  }

  return {workspaceId, layoutSessionBlock}
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

  const {workspaceId: activeWorkspaceId, layoutSessionBlock} = use(
    getInitialLayout(repo, hashSnapshot.hash, useRemoteSync, hashSnapshot.version),
  )

  useEffect(() => {
    const projection = new PanelLayoutProjection({
      repo,
      workspaceId: activeWorkspaceId,
      layoutSessionBlock,
    })
    const syncHash = () => {
      const nextHash = getCurrentHash()
      setHashSnapshot(current => {
        if (!layoutWorkspaceChanged(current.hash, nextHash)) return current
        return {hash: nextHash, version: current.version + 1}
      })
    }
    const unsubscribe = projection.subscribe(syncHash)
    let disposed = false
    void projection.start()
      .then(() => {
        if (disposed) {
          projection.dispose()
          return
        }
        syncHash()
      })
      .catch(error => {
        console.error('[App] Failed to start panel layout projection', error)
      })
    return () => {
      disposed = true
      unsubscribe()
      projection.dispose()
    }
  }, [repo, activeWorkspaceId, layoutSessionBlock])

  // Reactive role tracking. The imperative setReadOnly inside
  // resolveWorkspace handles the *initial* render (so the first paint
  // already has the right flag). This effect handles role changes pushed by
  // the server mid-session — e.g. an owner demoting an editor to viewer
  // while they're online — without requiring a reload.
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const activeRole = rolesByWorkspaceId.get(activeWorkspaceId)
  useEffect(() => {
    if (!activeRole) return
    repo.setReadOnly(activeRole === 'viewer')
  }, [activeRole, repo])

  return (
    <BlockContextProvider initialValue={{layoutBoundary: true, safeMode}}>
      <AppRuntimeProvider safeMode={safeMode}>
        <BlockComponent blockId={layoutSessionBlock.id}/>
      </AppRuntimeProvider>
    </BlockContextProvider>
  )
}

export default App
