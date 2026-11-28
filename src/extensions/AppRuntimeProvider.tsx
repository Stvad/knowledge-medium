import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { AppRuntimeController, type AppRuntimeContext } from '@/extensions/appRuntimeController.js'
import type { AppExtension, FacetRuntime } from '@/facets/facet.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import {useOverrides} from '@/extensions/useOverrides.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { appMountsFacet } from '@/extensions/core.js'
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
import { ensureExtensionUtilitiesCss } from '@/extensions/extensionUtilitiesCss.js'

const SAFELIST_WAIT_MS = 1500

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

  // Keep the last reports across re-resolutions and reset on workspace switch.
  const {errorStore, approvalStore} = useMemo(() => {
    void workspaceId
    return {
      errorStore: new ExtensionLoadErrorStore(),
      approvalStore: new ExtensionApprovalStatusStore(),
    }
  }, [workspaceId])

  // Keys (`${workspaceId}:${blockId}`) we've already toasted a load error
  // for. The runtime re-resolves on every toggle / refresh and a broken
  // block re-reports each time; this keeps the toast to once per block per
  // workspace for the provider's lifetime. The errorStore (status icons)
  // still reflects every report.
  const toastedLoadErrors = useRef<Set<string>>(new Set())

  const runtimeContext: AppRuntimeContext = useMemo(() => ({
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

  const controller = useMemo(() => new AppRuntimeController(), [])

  useEffect(() => {
    controller.publishBaseIfCold(baseRuntime, runtimeContext, setRuntime)
  }, [baseRuntime, controller, runtimeContext])

  useEffect(() => {
    const resolution = new AbortController()
    const utilitiesCss = ensureExtensionUtilitiesCss()
    void controller.resolve({
      baseExtensions,
      context: runtimeContext,
      overrides,
      errorStore,
      approvalStore,
      signal: resolution.signal,
      beforePublish: () => waitForExtensionUtilitiesCss(utilitiesCss),
      onRuntime: setRuntime,
      onLoadError: (blockId, error) => {
        toastExtensionLoadError(toastedLoadErrors.current, `${workspaceId}:${blockId}`, blockId, error)
      },
    })
    return () => resolution.abort()
  }, [approvalStore, baseExtensions, controller, errorStore, overrides, runtimeContext, workspaceId])

  useEffect(() => {
    // Reconcile the runtime React committed. A generation change alone only starts resolution.
    controller.reconcile(runtime, {repo, workspaceId, safeMode})
  }, [controller, repo, runtime, safeMode, workspaceId])

  useEffect(() => () => controller.dispose(), [controller])

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

// Wait for the deferred safelist before the first dynamic-extension paint.
// Bound the wait so a stalled stylesheet cannot block runtime publication.
async function waitForExtensionUtilitiesCss(utilitiesCss: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    utilitiesCss,
    new Promise(resolve => { timer = setTimeout(resolve, SAFELIST_WAIT_MS) }),
  ])
  clearTimeout(timer)
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
