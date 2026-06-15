import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { buildLayout, preserveHashQueryParams } from '@/utils/routing.js'
import { rememberWorkspace } from '@/utils/lastWorkspace.js'
import { seedTutorial } from '@/initData.js'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage.js'
import { getOrCreateTypesPage } from '@/data/typesPage.js'
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { workspaceLandingFacet } from '@/extensions/core.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { readOverridesCache } from '@/extensions/overridesCache.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import { applyCurrentLayoutUrl, createPanelRowInTx } from '@/utils/panelLayoutProjection.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { ChangeScope } from '@/data/api'

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

export interface WorkspaceBootstrapArgs {
  repo: Repo
  workspaceId: string
  freshlyCreated: boolean
  requestedHash: string
  /** The workspace id parsed from the requested hash (if any) — used to detect
   *  a URL pointing at a different workspace than the one we resolved. */
  requestedWorkspaceId: string | undefined
}

/**
 * The bootstrap *write* phase (§6 gate already cleared by the caller). Performs
 * the workspace-scoped writes — remember-as-default, one-shot backfills, the
 * starter tutorial, the Properties/Types/Recents pages, the ui-state block — and
 * applies the URL→layout projection (landing on a plugin-resolved block when the
 * layout is empty). Returns the layout-session block the app renders.
 *
 * Testable without rendering: it takes a repo and plain args and returns a Block.
 */
export const bootstrapWorkspace = async ({
  repo,
  workspaceId,
  freshlyCreated,
  requestedHash,
  requestedWorkspaceId,
}: WorkspaceBootstrapArgs): Promise<Block> => {
  // Only NOW remember it as the default. Remembering a locked/waiting workspace
  // would make the next empty-hash visit re-select it and render only the key
  // gate (no switcher), trapping the user away from accessible spaces.
  rememberWorkspace(workspaceId)

  // Workspace-scoped one-shot data backfills (workspaceBackfillsFacet) — e.g.
  // daily-notes deriving daily-note:date for pre-existing rows. Fire-and-forget:
  // the repo defers it off this critical path and gates it to run once per
  // workspace. Placed AFTER the access gate (in the caller) so we never write
  // into a locked / read-only workspace; routed through repo.tx so the derived
  // rows upload — a raw write would stay local, which is exactly how the
  // original daily-note:date backfill silently never synced.
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
  const hashForResolvedWorkspace = requestedWorkspaceId && requestedWorkspaceId !== workspaceId
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

  return layoutSessionBlock
}
