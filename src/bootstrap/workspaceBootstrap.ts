import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { buildLayout, preserveHashQueryParams } from '@/utils/routing.js'
import { rememberWorkspace } from '@/utils/lastWorkspace.js'
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

// Build the static-extension runtime for this bootstrap. It serves two roles:
//   1. It's installed into the Repo (`bootstrapWorkspace` below) as the
//      source of plugin data ownership (types / mutators / processors /
//      queries / system pages) — repo.tsx no longer installs a separate
//      `staticDataExtensions` list, so this is where the Repo learns about
//      plugin data before the bootstrap writes that need it.
//   2. Its `workspaceLandingFacet` resolvers decide the empty-layout
//      landing block. Dynamic plugins haven't loaded yet at this point,
//      and we don't want to give them the power to redirect first paint.
//
// Resolution goes through `resolveAppRuntimeSync` with the workspace's
// cached toggle overrides — NOT the bare collector — so a togglable
// boundary the user has disabled is honoured: a disabled plugin's data is
// genuinely absent from the Repo (no "secretly enabled" data) and a
// disabled landing contributor (e.g. `system:daily-notes`) doesn't steer
// first paint.
//
// Built FRESH every call — never cached. `repo.setFacetRuntime` MUTATES its
// argument (`adoptDurableContributionsFrom` copies the previous runtime's
// durable `user-data` buckets — user property schemas / types — onto it).
// Caching the object we hand to `setFacetRuntime` would let one workspace's
// adopted user-data accumulate on the shared instance and replay on a later
// bootstrap for another workspace, before that workspace's projectors clear
// and repopulate the bucket. A fresh object per bootstrap can't leak across
// workspaces. The build is cheap (the modules are already imported; this
// just walks the extension array), and getInitialLayout's promise cache
// already dedupes re-entry, so there's nothing to cache here. The same
// instance is reused for landing resolution below, so install and landing
// always agree on the contribution set.
const buildStaticAppRuntime = (repo: Repo) => {
  const workspaceId = repo.activeWorkspaceId
  const overrides = workspaceId
    ? readOverridesCache(workspaceId)
    : new Map<string, boolean>()
  return resolveAppRuntimeSync(staticAppExtensions({repo}), {
    overrides,
    context: {
      repo,
      workspaceId,
      safeMode: false,
    },
  })
}

// Walk landing resolvers in reverse (highest precedence last in the
// array — see `workspaceLandingFacet` docstring). Return the first
// non-null id, or null if every resolver punts. A throwing resolver
// is logged and skipped so a misbehaving plugin can't permanently
// block the user from booting the app.
const resolveLandingBlockId = async (
  repo: Repo,
  runtime: ReturnType<typeof buildStaticAppRuntime>,
  workspaceId: string,
  freshlyCreated: boolean,
): Promise<string | null> => {
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
  // Install the toggle-aware static-extension runtime into the Repo BEFORE
  // any bootstrap write. This is now the Repo's source of plugin data
  // ownership (types / mutators / processors / queries / system pages) —
  // repo.tsx no longer installs a separate `staticDataExtensions` list. It
  // must precede the writes below that depend on plugin data: ensureSystemPages
  // reads `systemPagesFacet`, the onboarding seed triggers the references
  // post-commit processor, and the daily-notes landing resolver calls
  // `repo.addTypeInTx(DAILY_NOTE_TYPE)` (which throws if the type is
  // unregistered). Resolved with the workspace's toggle overrides, so a
  // disabled plugin's data is genuinely absent. AppRuntimeProvider re-installs
  // the same tree (+ dynamic extensions) once it mounts; the contribution
  // instances are shared, so that later swap reads as additive. Built fresh
  // (not cached) because setFacetRuntime mutates it — see buildStaticAppRuntime.
  // Reused for landing resolution below.
  const staticRuntime = buildStaticAppRuntime(repo)
  repo.setFacetRuntime(staticRuntime)

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

  // The built-in data-integrity self-audit (L3) is now scheduled by the
  // data-integrity plugin's AppEffect (cadenced, read-only, deferred to idle),
  // which runs on workspace open and surfaces health via the diagnostics seam.

  // First-run starter content (the Tutorial pages + the [[Tutorial]]
  // discoverability bullet) is no longer seeded here: it's owned by the
  // onboarding plugin, which contributes a `workspaceLandingFacet` resolver
  // that seeds on `freshlyCreated` and then defers the landing target to
  // daily-notes (see src/plugins/onboarding). That keeps first-run content
  // out of the kernel and lets disabling the plugin remove it cleanly. The
  // tutorial's typed demos seed against `repo.snapshotTypeRegistries()`, which
  // is populated from the toggle-aware static-extension runtime installed
  // above — so the plugins' demo types are present for the seed.

  // Resolve the layout-session block the app paints — the warm-start critical
  // path. This chain is genuinely serial: each ui-state child's deterministic id
  // derives from its parent (user-page → ui-state → layout-sessions → session),
  // so it can't be collapsed, and the URL→layout projection + landing decision
  // depend on the session block. Runs concurrently with the kernel pages below.
  const resolveLayoutSession = async (): Promise<Block> => {
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
      const landingId = await resolveLandingBlockId(repo, staticRuntime, workspaceId, freshlyCreated)
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

  // Materialise the workspace's singleton system pages (Properties/Types/
  // Recents/Journal/Locations + any other `systemPagesFacet` contribution)
  // BEFORE resolving the layout. The landing resolver may seed content with
  // `[[reserved alias]]` wiki-links, and those must resolve to the canonical
  // page rather than auto-create a rival (alias.collision) — so the pages have
  // to exist first. That's why this is serialized ahead of the layout chain
  // rather than racing it the way these kernel pages used to (each is
  // idempotent + deterministic-id, so on a warm start it's just a cached read).
  await repo.ensureSystemPages(workspaceId)

  const layoutSessionBlock = await resolveLayoutSession()
  return layoutSessionBlock
}
