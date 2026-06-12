import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.js'
import { use, useCallback, useEffect, useState } from 'react'
import { useQuery } from '@powersync/react'
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
import { resolveAppRuntimeSync } from '@/extensions/resolveAppRuntime.js'
import { readOverridesCache } from '@/extensions/overridesCache.js'
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
import { getModePin, setModePin } from '@/sync/keys/modePin.js'
import { onWipeReload } from '@/sync/keys/flows/lockAndWipe.js'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import { decideWorkspaceEntry } from '@/sync/keys/workspaceAccess.js'
import { WorkspaceKeyGate } from '@/components/workspace/WorkspaceKeyGate.js'

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

// Pin a workspace plaintext, best-effort: a blocked/quota localStorage write
// must not abort bootstrap (the create dialog catches the same failure). Worst
// case the workspace shows the quarantine gate once on next load.
const pinPlaintextBestEffort = (userId: string, workspaceId: string): void => {
  try {
    setModePin(userId, workspaceId, 'plaintext')
  } catch (err) {
    console.warn(`[App] plaintext pin failed for ${workspaceId} (will quarantine on next load)`, err)
  }
}

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
    // A workspace WE just created is plaintext-confirmed (§8.1) — pin it so the
    // §6 gate never quarantines it. An already-existing personal workspace
    // (inserted=false) is left for the seed/gate to resolve.
    if (result.inserted) pinPlaintextBestEffort(repo.user.id, result.workspace.id)
    return {id: result.workspace.id, freshlyCreated: result.inserted}
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return {id: locals[0].id, freshlyCreated: false}

  // Remote sync disabled (e.g. dev mode without VITE_SUPABASE_*) and
  // nothing local yet: synthesize a deterministic per-user personal
  // workspace + owner membership locally so the rest of bootstrap
  // (seedTutorial, daily note, Tutorial bullet) can run unchanged.
  const local = await ensureLocalPersonalWorkspace(repo)
  // Same plaintext-confirm as the remote path (§8.1) so the gate stays out of
  // the way in local-only mode.
  if (local.inserted) pinPlaintextBestEffort(repo.user.id, local.workspace.id)
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
// redirect a user's first paint.
//
// Resolution goes through `resolveAppRuntimeSync` with the workspace's
// cached toggle overrides — NOT the bare collector — so a togglable
// boundary the user has disabled is honoured here too. Without this, a
// disabled non-essential plugin (e.g. `system:daily-notes`, the sole
// `workspaceLandingFacet` contributor) would still steer first paint.
//
// The cache keeps the cost down across re-entries via getInitialLayout's
// promise cache; entries are keyed by `repo.instanceId` + workspace +
// the override state, so a fresh Repo (new login), a workspace switch,
// or a mid-session toggle change (Settings dispatches
// `refreshAppRuntime`) all build a fresh runtime instead of replaying a
// stale one — otherwise a just-disabled daily-notes could still steer a
// later empty-layout navigation until a full reload.
const landingRuntimeCache = new Map<string, ReturnType<typeof resolveAppRuntimeSync>>()
const getLandingRuntime = (repo: Repo) => {
  const workspaceId = repo.activeWorkspaceId
  const overrides = workspaceId
    ? readOverridesCache(workspaceId)
    : new Map<string, boolean>()
  // Sparse map (only entries diverging from manifest defaults), sorted
  // for a stable key regardless of insertion order.
  const overridesFingerprint = JSON.stringify(
    [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
  const cacheKey = `${repo.instanceId}:${workspaceId ?? ''}:${overridesFingerprint}`
  const cached = landingRuntimeCache.get(cacheKey)
  if (cached) return cached
  const runtime = resolveAppRuntimeSync(staticAppExtensions({repo}), {
    overrides,
    context: {
      repo,
      workspaceId,
      safeMode: false,
    },
  })
  landingRuntimeCache.set(cacheKey, runtime)
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

  // §6 rule 3 access gate. Resolve whether this workspace can be materialized
  // for us right now BEFORE any bootstrap write below — those writes (daily
  // note, properties/types/recents pages, ui-state) would otherwise write
  // plaintext into an encrypted-but-locked workspace. If it can't, return a
  // `locked` layout and App renders the WorkspaceKeyGate. Safe because the
  // rollout seed has already pinned pre-existing plaintext workspaces, so only
  // genuinely locked/never-pinned workspaces land here.
  const pin = getModePin(repo.user.id, workspaceId)
  // Only an e2ee pin actually uses the workspace key. Reading the key store for
  // plaintext/unpinned workspaces is unnecessary and — if IndexedDB is
  // unavailable (private mode, disabled/corrupt storage) — would block an
  // otherwise-plaintext user from loading the app. A read failure is treated as
  // "no key" (→ locked, key-required) rather than aborting the bootstrap.
  let hasKey = false
  if (pin === 'e2ee') {
    try {
      hasKey = (await getWorkspaceKeyStore().get(repo.user.id, workspaceId)) !== null
    } catch (err) {
      console.warn(`[App] workspace key read failed for ${workspaceId}; treating as locked`, err)
    }
  }
  const gateWorkspace = await getLocalWorkspace(repo, workspaceId)
  const entry = decideWorkspaceEntry(pin, hasKey, gateWorkspace)
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
      workspaceName: gateWorkspace?.name ?? null,
      reason: entry.reason,
      canary: gateWorkspace?.wkCanary ?? null,
    }
  }

  // Ready — only NOW remember it as the default. Remembering a locked/waiting
  // workspace would make the next empty-hash visit re-select it and render only
  // the key gate (no switcher), trapping the user away from accessible spaces.
  rememberWorkspace(workspaceId)

  // Workspace-scoped one-shot data backfills (workspaceBackfillsFacet) — e.g.
  // daily-notes deriving daily-note:date for pre-existing rows. Fire-and-forget:
  // the repo defers it off this critical path and gates it to run once per
  // workspace. Placed AFTER the access gate (above) so we never write into a
  // locked / read-only workspace; routed through repo.tx so the derived rows
  // upload — a raw write would stay local, which is exactly how the original
  // daily-note:date backfill silently never synced.
  repo.scheduleWorkspaceBackfills(workspaceId)

  // One-time post-upgrade recovery for the deterministic-id shadow: clients that
  // skip-staled the server's authoritative row under the old reconcile gate
  // consumed its change-queue entry, so a normal startup never re-evaluates it.
  // Re-scan the workspace's staged rows once (marker-gated, deferred) so those
  // shadows heal on disk; visible on the next reload (the live cache LWW still
  // holds the default this session).
  repo.scheduleReconcileRescan(workspaceId)

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

  useEffect(() => {
    if (!layoutSessionBlock) return
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
    // Don't override the gate/waiting read-only lock with the role-derived flag
    // (an owner/editor of a *locked* workspace must stay read-only).
    if (initial.kind !== 'ready' || !activeRole) return
    repo.setReadOnly(activeRole === 'viewer')
  }, [initial.kind, activeRole, repo])

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

  // §6 Lock & wipe is all-or-nothing across tabs: when one same-user tab wipes,
  // every other tab must reload too, or it keeps the wiped plaintext in memory
  // and holds the OPFS DB handle open (blocking the boot-time file delete). The
  // wiping tab broadcasts; this listener reloads the rest into the fresh,
  // re-locked state.
  useEffect(() => {
    return onWipeReload(repo.user.id, () => window.location.reload())
  }, [repo.user.id])

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
    <BlockContextProvider initialValue={{layoutBoundary: true, safeMode}}>
      <AppRuntimeProvider safeMode={safeMode}>
        <BlockComponent blockId={initial.layoutSessionBlock.id}/>
      </AppRuntimeProvider>
    </BlockContextProvider>
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
