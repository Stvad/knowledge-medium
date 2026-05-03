import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Block } from '@/data/internals/block'
import { useRepo } from '@/context/repo.tsx'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.ts'
import { AppExtension, FacetResolveContext, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.ts'
import { appRuntimeUpdateEvent } from '@/extensions/runtimeEvents.ts'
import { useAgentRuntimeBridge } from '@/agentRuntime/useAgentRuntimeBridge.ts'
import { AgentTokensDialogMount } from '@/agentRuntime/AgentTokensDialog.tsx'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts.tsx'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.tsx'
import { videoPlayerPlugin } from '@/plugins/video-player'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { backlinksPlugin } from '@/plugins/backlinks'
import { updateIndicatorPlugin } from '@/plugins/update-indicator'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions.ts'
import { kernelDataExtension } from '@/data/internals/kernelDataExtension.ts'
import {
  ExtensionLoadErrorsProvider,
  ExtensionLoadErrorStore,
} from '@/extensions/extensionLoadErrors.tsx'

export function AppRuntimeProvider({
  children,
  landingBlock,
  safeMode,
}: {
  children: ReactNode
  landingBlock: Block
  safeMode: boolean
}) {
  const repo = useRepo()
  const [generation, setGeneration] = useState('initial-load')

  // One store per provider instance — survives runtime re-resolutions
  // (so the renderer can show errors from the most recent load) but
  // re-creates if the landing block changes (e.g. workspace switch).
  // landingBlock.id is the recreation key, not read inside the body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const errorStore = useMemo(() => new ExtensionLoadErrorStore(), [landingBlock.id])

  const runtimeContext: FacetResolveContext = useMemo(() => ({
    repo,
    landingBlock,
    safeMode,
    generation,
  }), [generation, repo, landingBlock, safeMode])

  const baseExtensions: AppExtension[] = useMemo(() => [
    // kernelDataExtension contributes KERNEL_MUTATORS and
    // KERNEL_PROCESSORS to mutatorsFacet / postCommitProcessorsFacet.
    // setFacetRuntime REPLACES the registries, so without this the
    // kernel mutators (registered in the Repo constructor) would be
    // dropped the first time the runtime resolves and any
    // repo.mutate.<kernel> call would throw MutatorNotRegisteredError.
    kernelDataExtension,
    defaultRenderersExtension,
    defaultEditorInteractionExtension,
    defaultActionsExtension({repo}),
    plainOutlinerPlugin,
    vimNormalModePlugin({repo}),
    videoPlayerPlugin,
    backlinksPlugin,
    updateIndicatorPlugin,
  ], [repo])

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

    const workspaceId =
      landingBlock.peek()?.workspaceId ?? repo.activeWorkspaceId
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
  }, [baseExtensions, errorStore, repo, landingBlock, runtimeContext, safeMode])

  useAgentRuntimeBridge({
    repo,
    landingBlock,
    runtime,
    safeMode,
  })

  return (
    <AppRuntimeContextProvider value={runtime}>
      <ExtensionLoadErrorsProvider store={errorStore}>
        <ActiveContextsProvider>
          <HotkeyReconciler/>
          <AgentTokensDialogMount/>
          {children}
        </ActiveContextsProvider>
      </ExtensionLoadErrorsProvider>
    </AppRuntimeContextProvider>
  )
}
