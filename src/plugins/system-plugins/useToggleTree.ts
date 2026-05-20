/**
 * Walk the full extension tree (static + dynamic) into a
 * `ToggleNode[]` for the settings UI.
 *
 * The hook owns the lifecycle:
 *   - rebuilds the tree whenever the `generation` from `useOverrides`
 *     bumps (i.e. `refreshAppRuntime` fired — likely the user just
 *     toggled something or a new extension block landed)
 *   - rebuilds on workspace switch
 *   - awaits the dynamicExtensionsExtension function so user-extension
 *     shell rows surface in the tree even when disabled (their
 *     compile is skipped but the shell handle is still emitted)
 */

import {useEffect, useMemo, useState} from 'react'
import {useRepo} from '@/context/repo.tsx'
import {dynamicExtensionsExtension} from '@/extensions/dynamicExtensions.ts'
import {
  discoverToggleTree,
  type ToggleNode,
} from '@/extensions/discoverToggleTree.ts'
import {useAppRuntime} from '@/extensions/runtimeContext.ts'
import {staticAppExtensions} from '@/extensions/staticAppExtensions.ts'
import {useOverrides} from '@/extensions/useOverrides.ts'

export interface UseToggleTreeResult {
  tree: readonly ToggleNode[]
  loading: boolean
  workspaceId?: string
}

export const useToggleTree = (): UseToggleTreeResult => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const {overrides, generation} = useOverrides(workspaceId)
  // Settings is the recovery surface in `?safeMode`. We MUST thread
  // the real safeMode flag through dynamicExtensionsExtension here —
  // hard-coding `false` would compile every enabled extension block at
  // discovery time, defeating the whole point of safe mode. The
  // AppRuntimeProvider stashes safeMode on the FacetResolveContext, so
  // we read it back from the live runtime.
  const runtime = useAppRuntime()
  const safeMode = runtime.context.safeMode === true

  const [tree, setTree] = useState<readonly ToggleNode[]>([])
  const [loading, setLoading] = useState(true)

  const baseExtensions = useMemo(() => staticAppExtensions({repo}), [repo])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    void (async () => {
      const dynamic = dynamicExtensionsExtension({
        repo,
        workspaceId,
        safeMode,
        // Pass the real overrides so disabled blocks take the pre-compile
        // skip path AND surface as `userExtensionShellToggle(block).of([])`
        // shells. Their boundary handle is still discoverable by the tree
        // walk; only the module source isn't run — which is exactly what
        // makes disabling user extensions safe (their top-level code
        // doesn't execute). In safe mode dynamicExtensions short-circuits
        // every block to a shell regardless of override state.
        overrides,
      })

      // discoverToggleTree uses `safeMode: false` deliberately: in safe
      // mode the resolver would skip the boundary subtrees of every
      // non-essential toggle, hiding their rows from the tree. The tree
      // walker keeps boundaries discoverable for *display*, while the
      // production resolver still enforces the runtime force-off.
      const next = await discoverToggleTree(
        [baseExtensions, dynamic],
        {repo, workspaceId, safeMode: false, generation},
      )

      if (!cancelled) {
        setTree(next)
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [baseExtensions, repo, workspaceId, overrides, generation, safeMode])

  return {tree, loading, workspaceId: workspaceId ?? undefined}
}
