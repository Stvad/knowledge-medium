// User-intent navigation primitive. Single entry point for "go to a block"
// and "open a block in a new panel" — collapsing the previous split between
// writeAppHash() and the 'open-panel' CustomEvent into one verb.
//
// Treated as a runtime service (like Repo or AppRuntime), not a facet:
// navigation is a fundamental action with one canonical implementation, not
// an extensibility surface that composes contributions. If extensions
// later need to intercept navigation (e.g. a block type that opens in a
// custom viewer rather than as a focused block), this is where a
// navigationInterceptorFacet would plug in — navigate() would consult
// `runtime.read(...)` before falling through to the default URL / event
// implementation. Keeping the API a plain function for now lets that hook
// be added without re-plumbing call sites.
import { useCallback } from 'react'
import type { Repo } from '@/data/repo'
import { useRepo } from '@/context/repo'
import { writeAppHash } from './routing'

export type NavigationTarget = 'focused' | 'new-panel'

export interface NavigateInput {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
  target: NavigationTarget
  /** When target='new-panel', the panel that initiated this so the panel
   *  manager can position the new panel adjacent to it. Ignored otherwise. */
  sourcePanelId?: string
}

export const navigate = (repo: Repo, input: NavigateInput): void => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return

  if (input.target === 'new-panel') {
    window.dispatchEvent(new CustomEvent('open-panel', {
      detail: {
        blockId: input.blockId,
        sourcePanelId: input.sourcePanelId,
      },
    }))
    return
  }

  // target === 'focused'. Until focused-panel navigation lands (step 3 of
  // the nav refactor), 'focused' = main panel = URL hash. Side-panel
  // zoom-in still bypasses navigate() and writes a panel-local property
  // directly; that asymmetry is the bug we'll fix when this branch starts
  // dispatching to the focused panel instead of the URL.
  writeAppHash(workspaceId, input.blockId)
}

export const useNavigate = () => {
  const repo = useRepo()
  return useCallback((input: NavigateInput) => navigate(repo, input), [repo])
}
