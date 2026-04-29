import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.ts'
import { AppExtension, FacetResolveContext, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.ts'
import { appRuntimeUpdateEvent } from '@/extensions/runtimeEvents.ts'
import { useAgentRuntimeBridge } from '@/agentRuntime/useAgentRuntimeBridge.ts'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts.tsx'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.tsx'
import { videoPlayerPlugin } from '@/plugins/video-player'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { backlinksPlugin } from '@/plugins/backlinks'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions.ts'
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
  const errorStore = useMemo(
    () => new ExtensionLoadErrorStore(),
    [landingBlock.id],
  )

  const runtimeContext: FacetResolveContext = useMemo(() => ({
    repo,
    landingBlock,
    safeMode,
    generation,
  }), [generation, repo, landingBlock, safeMode])

  const baseExtensions: AppExtension[] = useMemo(() => [
    defaultRenderersExtension,
    defaultEditorInteractionExtension,
    defaultActionsExtension({repo}),
    plainOutlinerPlugin,
    vimNormalModePlugin({repo}),
    videoPlayerPlugin,
    backlinksPlugin,
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

  useEffect(() => {
    setRuntime(baseRuntime)
  }, [baseRuntime])

  useEffect(() => {
    let cancelled = false
    // Wipe stale errors from the previous resolution; the loader will
    // re-report any that still apply.
    errorStore.reset()

    const workspaceId =
      landingBlock.dataSync()?.workspaceId ?? repo.activeWorkspaceId
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
          {children}
        </ActiveContextsProvider>
      </ExtensionLoadErrorsProvider>
    </AppRuntimeContextProvider>
  )
}
