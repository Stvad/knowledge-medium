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
import {staticAppExtensions} from '@/extensions/staticAppExtensions.ts'
import {useOverrides} from '@/extensions/useOverrides.ts'

export interface UseToggleTreeResult {
  tree: readonly ToggleNode[]
  loading: boolean
}

export const useToggleTree = (): UseToggleTreeResult => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const {overrides, generation} = useOverrides(workspaceId)

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
        safeMode: false,
        // Pass the real overrides so disabled blocks take the pre-compile
        // skip path AND surface as `userExtensionShellToggle(block).of([])`
        // shells. Their boundary handle is still discoverable by the tree
        // walk; only the module source isn't run — which is exactly what
        // makes disabling user extensions safe (their top-level code
        // doesn't execute).
        overrides,
      })

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
  }, [baseExtensions, repo, workspaceId, overrides, generation])

  return {tree, loading}
}
