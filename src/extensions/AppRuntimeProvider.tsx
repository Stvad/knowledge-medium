import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.js'
import {
  AppExtension,
  FacetResolveContext,
  FacetRuntime,
} from '@/facets/facet.js'
import {
  resolveAppRuntime,
  resolveAppRuntimeSync,
} from '@/facets/resolveAppRuntime.js'
import {useOverrides} from '@/extensions/useOverrides.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { appMountsFacet } from '@/extensions/core.js'
import { EffectReconciler } from '@/extensions/liveRuntime.js'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts.js'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import {
  ExtensionLoadErrorsProvider,
  ExtensionLoadErrorStore,
} from '@/extensions/extensionLoadErrors.js'
import {
  ExtensionApprovalStatusProvider,
  ExtensionApprovalStatusStore,
} from '@/extensions/extensionApprovalStatus.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import { toastExtensionLoadError } from '@/extensions/extensionLoadErrorToast.js'

export function AppRuntimeProvider({
  children,
  safeMode,
}: {
  children: ReactNode
  safeMode: boolean
}) {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  // First-paint overrides + refresh-event subscription. The hook reads
  // the localStorage cache mirroring the synced Extensions block,
  // and re-reads after any `refreshAppRuntime()` dispatch (which the
  // meta-plugin's subscribe effect fires whenever the cache and the
  // canonical block diverge).
  const {overrides, generation} = useOverrides(workspaceId)

  // One store per provider instance — survives runtime re-resolutions
  // (so the renderer can show errors from the most recent load) and
  // re-creates on workspace switch.
  const errorStore = useMemo(() => {
    void workspaceId
    return new ExtensionLoadErrorStore()
  }, [workspaceId])

  // Keys (`${workspaceId}:${blockId}`) we've already toasted a load error
  // for. The runtime re-resolves on every toggle / refresh and a broken
  // block re-reports each time; this keeps the toast to once per block per
  // workspace for the provider's lifetime. The errorStore (status icons)
  // still reflects every report.
  const toastedLoadErrors = useRef<Set<string>>(new Set())

  // Device-local trust status (needs-approval / update-available) for the
  // current resolution, surfaced to the Extensions settings UI (#67). Same
  // per-provider / per-workspace lifecycle as the error store.
  const approvalStore = useMemo(() => {
    void workspaceId
    return new ExtensionApprovalStatusStore()
  }, [workspaceId])

  const runtimeContext: FacetResolveContext = useMemo(() => ({
    repo,
    workspaceId,
    safeMode,
    generation,
  }), [generation, repo, workspaceId, safeMode])

  const baseExtensions: AppExtension[] = useMemo(() => staticAppExtensions({repo}), [repo])

  const baseRuntime = useMemo(() =>
    resolveAppRuntimeSync(baseExtensions, {overrides, safeMode, context: runtimeContext}),
  [baseExtensions, overrides, safeMode, runtimeContext])

  const [runtime, setRuntime] = useState(baseRuntime)

  // App-effect lifecycle (audit B1(4)). The reconciler keeps unchanged
  // effects running across a runtime swap (re-pointing them at the fresh
  // runtime via a LiveRuntimeHandle) and starts/stops only the diff, so
  // toggling one extension no longer restarts every plugin's effect /
  // subscriptions. It restarts everything only when repo / workspaceId /
  // safeMode change (values effects capture directly). It also owns the
  // authoritative cold-vs-warm latch (`isColdFor`) the gated commit below
  // consults — declared here so that effect can reference it.
  const effectReconciler = useMemo(() => new EffectReconciler(), [])

  // Two-stage load is only worth its cost on a COLD start for a context —
  // initial mount and repo / workspace / safeMode switch. There we commit
  // the sync `baseRuntime` immediately so the kernel + static plugins (and
  // their mutators / processors) come up and the UI paints without waiting
  // on the async dynamic-extension compile; the async effect below then
  // swaps in the merged runtime.
  //
  // On a same-context RELOAD (extension toggle / `refreshAppRuntime` →
  // generation bump, or an overrides change) we deliberately SKIP that
  // intermediate. The current merged runtime is already live and valid for
  // this context; holding it until the async resolve swaps it once avoids
  // (a) churning every dynamic effect through a stop→start (baseRuntime
  // carries no dynamic extensions, so they'd read as "removed" then
  // "re-added"), and (b) momentarily downgrading the Repo to static-only
  // and dropping the live dynamic plugins' mutators during the compile gap.
  //
  // "Cold vs warm" is the reconciler's `isColdFor` — its capturedCtx is the
  // single source of truth, so this commit and the reconcile below can't
  // disagree about whether a change is a context switch or a reload.
  useEffect(() => {
    if (!effectReconciler.isColdFor(repo, workspaceId, safeMode)) return // warm reload: hold current; async swaps once
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync-state-from-prop: held runtime follows baseRuntime on cold start
    setRuntime(baseRuntime)
    repo.setFacetRuntime(baseRuntime)
  }, [baseRuntime, effectReconciler, repo, workspaceId, safeMode])

  useEffect(() => {
    let cancelled = false
    // Buffer this resolution's error + trust-status reports and publish each
    // store as ONE atomic old→new transition on success (commitBatch below),
    // instead of resetting to empty now and dribbling re-reports in after the
    // async resolve. The reset→dribble shape briefly blanked both maps, which
    // flickered the global prompt toasts + status-chip dot (and blinked the
    // row status icons). The loader re-reports every still-applicable entry,
    // so the batch starts empty and drops anything no longer reported.
    errorStore.beginBatch()
    approvalStore.beginBatch()

    if (!workspaceId) {
      // Should not happen — getInitialBlock sets activeWorkspaceId
      // before any render. If it does, there's nothing to load.
      errorStore.abandonBatch()
      approvalStore.abandonBatch()
      return
    }

    void (async () => {
      try {
        const nextRuntime = await resolveAppRuntime([
          baseExtensions,
          dynamicExtensionsExtension({
            repo,
            workspaceId,
            safeMode,
            // Threaded so the loader can skip disabled blocks
            // *before* compileExtensionModule (i.e. their top-level
            // code never runs) and tag the survivors with toggle
            // boundaries the resolver can re-evaluate.
            overrides,
            errorReporter: (blockId, error) => {
              if (cancelled) return
              errorStore.reportError(blockId, error)
              toastExtensionLoadError(
                toastedLoadErrors.current,
                `${workspaceId}:${blockId}`,
                blockId,
                error,
              )
            },
            approvalStatusReporter: (blockId, status) => {
              if (cancelled) return
              approvalStore.report(blockId, status)
            },
          }),
        ], {overrides, safeMode, context: runtimeContext})

        if (!cancelled) {
          // Publish both maps atomically now that the resolve is complete.
          errorStore.commitBatch()
          approvalStore.commitBatch()
          setRuntime(nextRuntime)
          // Sync the merged runtime (kernel + static + dynamic) into
          // Repo so plugin-contributed mutators and post-commit
          // processors land in the registries. Without this call,
          // dynamic-plugin facet contributions would only flow through
          // the FacetRuntime to UI consumers, never reaching the data
          // layer's dispatch / processor surfaces.
          repo.setFacetRuntime(nextRuntime)
        }
        // On cancel we intentionally leave the buffers uncommitted; the next
        // resolve's beginBatch discards them. (Stores are also recreated per
        // workspace, so a switch can't leak a stale buffer.)
      } catch (error) {
        console.error('Failed to resolve app runtime', error)
        // A throw is NOT guaranteed to be followed by another resolve (unlike
        // cancel), so close the batches explicitly — otherwise they'd stay
        // open and every later report/clear would silently buffer into a dead
        // map with no notify. abandonBatch leaves the last-known map intact
        // (stale-on-error, which is better than blanking every prompt).
        errorStore.abandonBatch()
        approvalStore.abandonBatch()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [approvalStore, baseExtensions, errorStore, overrides, repo, runtimeContext, safeMode, workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      // Workspace cleared while still mounted: tear down running effects
      // so their subscriptions / intervals / window hooks don't stay
      // bound to the stale workspace. The previous single-effect
      // lifecycle did this implicitly via its deps cleanup; the split
      // reconcile/dispose effects otherwise only dispose on unmount.
      effectReconciler.dispose()
      return
    }
    effectReconciler.reconcile(repo, runtime, workspaceId, safeMode)
  }, [effectReconciler, repo, runtime, safeMode, workspaceId])

  // Provider unmount: stop every running effect. Kept separate from the
  // reconcile effect above so a deps change re-runs reconciliation
  // (the diff) rather than tearing every effect down.
  useEffect(() => () => effectReconciler.dispose(), [effectReconciler])

  // Start every definition-block projector (issue #90) for the active
  // workspace: user-defined property-schema blocks → propertySchemasFacet
  // and block-type blocks → typesFacet, each mirrored into a 'user-data'
  // bucket by the shared ProjectorRuntime. `startAll` reads the
  // descriptors from `definitionBlockProjectorFacet` and starts them in
  // dependency order (schemas before types, since the type build path
  // resolves block-type:properties refs through the schema projector);
  // the returned disposer tears them down in reverse. The same singleton
  // facades (repo.userSchemas / repo.userTypes) that imperative call
  // sites use — e.g. addSchema on AddPropertyForm submit — read the
  // resulting in-memory state through this runtime.
  useEffect(() => {
    if (!workspaceId) return
    const dispose = repo.projectors.startAll()
    return () => dispose()
  }, [repo, workspaceId])

  return (
    <AppRuntimeContextProvider value={runtime}>
      <ExtensionLoadErrorsProvider store={errorStore}>
        <ExtensionApprovalStatusProvider store={approvalStore}>
          <ActiveContextsProvider>
            <HotkeyReconciler/>
            <AppMounts runtime={runtime}/>
            {children}
          </ActiveContextsProvider>
        </ExtensionApprovalStatusProvider>
      </ExtensionLoadErrorsProvider>
    </AppRuntimeContextProvider>
  )
}

function AppMounts({runtime}: {runtime: FacetRuntime}) {
  const mounts = useMemo(() => runtime.read(appMountsFacet), [runtime])

  return (
    <>
      {mounts.map(({id, component: Component}) => (
        <ExtensionRenderBoundary key={id}>
          <Component/>
        </ExtensionRenderBoundary>
      ))}
    </>
  )
}
