import { ReactNode, use, useEffect, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { dynamicRenderersExtension } from '@/extensions/dynamicRenderers.ts'
import { AppExtension, resolveFacetRuntime } from '@/extensions/facet.ts'
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

  useEffect(() => {
    const reloadRuntime = (event: CustomEvent<string>) => {
      setGeneration(event.detail)
    }

    window.addEventListener(appRuntimeUpdateEvent, reloadRuntime as EventListener)
    return () => window.removeEventListener(appRuntimeUpdateEvent, reloadRuntime as EventListener)
  }, [])

  const extensions: AppExtension[] = useMemo(() => [
    defaultRenderersExtension,
    defaultActionsExtension({repo}),
    dynamicRenderersExtension({rootBlock, safeMode}),
  ], [repo, rootBlock, safeMode])

  const runtimePromise = useMemo(() =>
    resolveFacetRuntime(extensions, {
      repo,
      rootBlock,
      safeMode,
      generation,
    }),
  [extensions, generation, repo, rootBlock, safeMode])

  const runtime = use(runtimePromise)

  return (
    <AppRuntimeContextProvider value={runtime}>
      {children}
    </AppRuntimeContextProvider>
  )
}
