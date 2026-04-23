import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { dynamicRenderersExtension } from '@/extensions/dynamicRenderers.ts'
import { AppExtension, FacetResolveContext, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.ts'
import { appRuntimeUpdateEvent } from '@/extensions/runtimeEvents.ts'

export function AppRuntimeProvider({
  children,
  rootBlock,
  safeMode,
}: {
  children: ReactNode
  rootBlock: Block
  safeMode: boolean
}) {
  const repo = useRepo()
  const [generation, setGeneration] = useState('initial-load')

  const runtimeContext: FacetResolveContext = useMemo(() => ({
    repo,
    rootBlock,
    safeMode,
    generation,
  }), [generation, repo, rootBlock, safeMode])

  const baseExtensions: AppExtension[] = useMemo(() => [
    defaultRenderersExtension,
    defaultActionsExtension({repo}),
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

    void (async () => {
      try {
        const nextRuntime = await resolveFacetRuntime([
          baseExtensions,
          dynamicRenderersExtension({rootBlock, safeMode}),
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
  }, [baseExtensions, rootBlock, runtimeContext, safeMode])

  return (
    <AppRuntimeContextProvider value={runtime}>
      {children}
    </AppRuntimeContextProvider>
  )
}
