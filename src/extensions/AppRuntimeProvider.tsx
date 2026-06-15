import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Repo } from '@/data/repo.js'
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
import { appEffectsFacet, appMountsFacet, type AppEffect, type AppEffectCleanup } from '@/extensions/core.js'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts.js'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import {
  ExtensionLoadErrorsProvider,
  ExtensionLoadErrorStore,
} from '@/extensions/extensionLoadErrors.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'

/** A live app effect: its definition object, the cleanup once `start`
 *  resolves (null until then / if none), and a `stopped` flag so an
 *  async cleanup that resolves after teardown still runs exactly once. */
interface RunningAppEffect {
  effect: AppEffect
  cleanup: AppEffectCleanup | null
  stopped: boolean
}

/** Run an app effect's cleanup, isolating sync + async failures so one
 *  bad cleanup can't abort the rest of a teardown. */
const runAppEffectCleanup = (cleanup: AppEffectCleanup, effectId: string): void => {
  try {
    const result = cleanup()
    if (result instanceof Promise) {
      result.catch(error => {
        console.error(`App effect cleanup failed for ${effectId}`, error)
      })
    }
  } catch (error) {
    console.error(`App effect cleanup failed for ${effectId}`, error)
  }
}

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

  // Sync state-from-prop pattern: when `baseRuntime` changes (rare —
  // only on `repo` swap or generation reload) the held `runtime` must
  // follow. The same effect also pushes that runtime into the Repo
  // registries. The async effect below will replace it once dynamic
  // plugins resolve, but the sync runtime keeps kernel + static plugin
  // mutators / processors live during that gap.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRuntime(baseRuntime)
    repo.setFacetRuntime(baseRuntime)
  }, [baseRuntime, repo])

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

  // App-effect lifecycle, reconciled by effect id (audit B1). A runtime
  // swap REPLACES every facet registry, but most swaps (an extension
  // toggle, the dynamic-load follow-up) leave the bulk of
  // `appEffectsFacet`'s contributions byte-identical. Tearing down and
  // restarting ALL effects on every swap needlessly drops every plugin's
  // subscriptions; instead we diff the desired effects against the
  // running set and touch only what changed. A change to a ctx input
  // (workspace switch, repo swap, safeMode toggle) still restarts
  // everything — those effects captured the old ctx.
  const runningEffectsRef = useRef<Map<string, RunningAppEffect>>(new Map())
  const prevEffectCtxRef = useRef<{repo: Repo; workspaceId: string; safeMode: boolean} | null>(null)

  useEffect(() => {
    const running = runningEffectsRef.current

    const stopEntry = (id: string, entry: RunningAppEffect): void => {
      entry.stopped = true
      if (entry.cleanup) runAppEffectCleanup(entry.cleanup, id)
      running.delete(id)
    }

    // No active workspace: stop everything and reset the ctx baseline so
    // the next workspace starts from a clean slate. (Shouldn't happen —
    // getInitialBlock sets activeWorkspaceId before any render.)
    if (!workspaceId) {
      for (const [id, entry] of [...running].reverse()) stopEntry(id, entry)
      prevEffectCtxRef.current = null
      return
    }

    const ctx = {repo, runtime, workspaceId, safeMode}

    const startEffect = (effect: AppEffect): void => {
      const entry: RunningAppEffect = {effect, cleanup: null, stopped: false}
      running.set(effect.id, entry)
      try {
        const result = effect.start(ctx)
        Promise.resolve(result).then(cleanup => {
          if (typeof cleanup !== 'function') return
          // Stopped (or replaced) before start resolved → clean up now.
          if (entry.stopped || running.get(effect.id) !== entry) {
            runAppEffectCleanup(cleanup, effect.id)
            return
          }
          entry.cleanup = cleanup
        }).catch(error => {
          console.error(`App effect failed to start for ${effect.id}`, error)
        })
      } catch (error) {
        console.error(`App effect failed to start for ${effect.id}`, error)
      }
    }

    // A ctx-input change must restart every effect; a pure runtime swap
    // gets the by-id diff below.
    const prev = prevEffectCtxRef.current
    const ctxChanged = !prev
      || prev.repo !== repo
      || prev.workspaceId !== workspaceId
      || prev.safeMode !== safeMode
    prevEffectCtxRef.current = {repo, workspaceId, safeMode}
    if (ctxChanged) {
      for (const [id, entry] of [...running].reverse()) stopEntry(id, entry)
    }

    const desired = new Map<string, AppEffect>()
    for (const effect of runtime.read(appEffectsFacet)) desired.set(effect.id, effect)

    // Stop effects that are gone, or whose definition object changed
    // (same id, different contribution ⇒ restart with the new one).
    for (const [id, entry] of [...running]) {
      const want = desired.get(id)
      if (!want || want !== entry.effect) stopEntry(id, entry)
    }
    // Start everything desired that isn't already running (new, replaced,
    // or just torn down by the ctx-change reset).
    for (const [id, effect] of desired) {
      if (!running.has(id)) startEffect(effect)
    }
  }, [repo, runtime, safeMode, workspaceId])

  // True-unmount teardown only — per-swap reconciliation is handled
  // above, so this must NOT fire on every runtime change (empty deps).
  useEffect(() => {
    const running = runningEffectsRef.current
    return () => {
      for (const [id, entry] of [...running].reverse()) {
        entry.stopped = true
        if (entry.cleanup) runAppEffectCleanup(entry.cleanup, id)
      }
      running.clear()
    }
  }, [])

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
