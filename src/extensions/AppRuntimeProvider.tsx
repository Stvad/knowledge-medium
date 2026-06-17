import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import type { Repo } from '@/data/repo'
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
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'

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
  const loadedCtx = useRef<{repo: Repo; workspaceId: string | null; safeMode: boolean} | null>(null)
  useEffect(() => {
    const ctxChanged =
      loadedCtx.current === null ||
      loadedCtx.current.repo !== repo ||
      loadedCtx.current.workspaceId !== workspaceId ||
      loadedCtx.current.safeMode !== safeMode
    if (!ctxChanged) return // same-context reload: keep current; async swaps once
    loadedCtx.current = {repo, workspaceId, safeMode}
    setRuntime(baseRuntime)
    repo.setFacetRuntime(baseRuntime)
  }, [baseRuntime, repo, workspaceId, safeMode])

  useEffect(() => {
    let cancelled = false
    // Wipe stale errors from the previous resolution; the loader will
    // re-report any that still apply.
    errorStore.reset()

    if (!workspaceId) {
      // Should not happen — getInitialBlock sets activeWorkspaceId
      // before any render. If it does, there's nothing to load.
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
            },
          }),
        ], {overrides, safeMode, context: runtimeContext})

        if (!cancelled) {
          setRuntime(nextRuntime)
          // Sync the merged runtime (kernel + static + dynamic) into
          // Repo so plugin-contributed mutators and post-commit
          // processors land in the registries. Without this call,
          // dynamic-plugin facet contributions would only flow through
          // the FacetRuntime to UI consumers, never reaching the data
          // layer's dispatch / processor surfaces.
          repo.setFacetRuntime(nextRuntime)
        }
      } catch (error) {
        console.error('Failed to resolve app runtime', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [baseExtensions, errorStore, overrides, repo, runtimeContext, safeMode, workspaceId])

  // App-effect lifecycle (audit B1(4)). The reconciler keeps unchanged
  // effects running across a runtime swap (re-pointing them at the fresh
  // runtime via a LiveRuntimeHandle) and starts/stops only the diff, so
  // toggling one extension no longer restarts every plugin's effect /
  // subscriptions. It restarts everything only when repo / workspaceId /
  // safeMode change (values effects capture directly).
  const effectReconciler = useMemo(() => new EffectReconciler(), [])

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

  // Reactive bridge between user-defined property-schema blocks and
  // propertySchemasFacet's user-data bucket (Phase 3b). The service
  // is the same singleton imperative call sites use (e.g. addSchema
  // on AddPropertyForm submit) so the in-memory contribution list
  // stays consistent.
  useEffect(() => {
    if (!workspaceId) return
    const dispose = repo.userSchemas.start()
    return () => dispose()
  }, [repo, workspaceId])

  // Symmetric bridge for user-defined block-type blocks → typesFacet's
  // user-data bucket (user-defined-types Phase 1). Started after
  // userSchemas because the type build path resolves
  // block-type:properties refs through UserSchemasService.
  useEffect(() => {
    if (!workspaceId) return
    const dispose = repo.userTypes.start()
    return () => dispose()
  }, [repo, workspaceId])

  return (
    <AppRuntimeContextProvider value={runtime}>
      <ExtensionLoadErrorsProvider store={errorStore}>
        <ActiveContextsProvider>
          <HotkeyReconciler/>
          <AppMounts runtime={runtime}/>
          {children}
        </ActiveContextsProvider>
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
