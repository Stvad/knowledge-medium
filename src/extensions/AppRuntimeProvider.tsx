import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useRepo } from '@/context/repo.tsx'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.ts'
import {
  AppExtension,
  FacetResolveContext,
  FacetRuntime,
  resolveFacetRuntime,
  resolveFacetRuntimeSync,
} from '@/extensions/facet.ts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import { appRuntimeUpdateEvent } from '@/extensions/runtimeEvents.ts'
import { appEffectsFacet, appMountsFacet, type AppEffectCleanup } from '@/extensions/core.ts'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts.tsx'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.tsx'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.ts'
import {
  ExtensionLoadErrorsProvider,
  ExtensionLoadErrorStore,
} from '@/extensions/extensionLoadErrors.tsx'

export function AppRuntimeProvider({
  children,
  safeMode,
}: {
  children: ReactNode
  safeMode: boolean
}) {
  const repo = useRepo()
  const [generation, setGeneration] = useState('initial-load')
  const workspaceId = repo.activeWorkspaceId

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
    resolveFacetRuntimeSync(baseExtensions, runtimeContext),
  [baseExtensions, runtimeContext])

  const [runtime, setRuntime] = useState(baseRuntime)

  useEffect(() => {
    const reloadRuntime = (event: CustomEvent<string>) => {
      setGeneration(event.detail)
    }

    window.addEventListener(appRuntimeUpdateEvent, reloadRuntime as EventListener)
    return () => window.removeEventListener(appRuntimeUpdateEvent, reloadRuntime as EventListener)
  }, [])

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
        const nextRuntime = await resolveFacetRuntime([
          baseExtensions,
          dynamicExtensionsExtension({
            repo,
            workspaceId,
            safeMode,
            errorReporter: (blockId, error) => {
              if (cancelled) return
              errorStore.reportError(blockId, error)
            },
          }),
        ], runtimeContext)

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
  }, [baseExtensions, errorStore, repo, runtimeContext, safeMode, workspaceId])

  useEffect(() => {
    if (!workspaceId) return

    let disposed = false
    const cleanups: Array<{effectId: string; cleanup: AppEffectCleanup}> = []
    const effects = runtime.read(appEffectsFacet)

    const runCleanup = (cleanup: AppEffectCleanup, effectId: string) => {
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

    for (const effect of effects) {
      try {
        const result = effect.start({
          repo,
          runtime,
          workspaceId,
          safeMode,
        })

        Promise.resolve(result).then(cleanup => {
          if (typeof cleanup !== 'function') return
          if (disposed) {
            runCleanup(cleanup, effect.id)
            return
          }
          cleanups.push({effectId: effect.id, cleanup})
        }).catch(error => {
          console.error(`App effect failed to start for ${effect.id}`, error)
        })
      } catch (error) {
        console.error(`App effect failed to start for ${effect.id}`, error)
      }
    }

    return () => {
      disposed = true
      for (const {effectId, cleanup} of cleanups.toReversed()) {
        runCleanup(cleanup, effectId)
      }
      cleanups.length = 0
    }
  }, [repo, runtime, safeMode, workspaceId])

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
        <Component key={id}/>
      ))}
    </>
  )
}
