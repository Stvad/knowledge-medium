import { createContext, useContext } from 'react'
import { buildAppHashInContext, buildLayoutFromSlots } from '@/utils/routing'

/** The ws-context the RENDERING layout session lives under — provided by
 *  whoever mounts a session subtree so in-app anchors carry the right lane.
 *
 *  Why not the global hash: a warm-hidden session's subtree keeps
 *  re-rendering while another same-workspace session is active (shared repo
 *  data updates reach mounted-but-hidden trees), so an anchor reading
 *  `window.location.hash` at render time would stamp the OTHER lane's
 *  context onto this session's hrefs — and a modified/middle click after
 *  reactivation would follow the stale lane.
 *
 *  `null` (no provider) = single-session rendering: fall back to the
 *  current global hash at render time, which is correct when only the
 *  active session's tree renders (core today). A session host that keeps
 *  multiple sessions mounted MUST wrap each session subtree in a provider
 *  carrying that session's own workspace + ws-context (empty array for the
 *  base session — its links are deliberately context-free). */
export interface LayoutWsContextValue {
  workspaceId: string
  wsContext: readonly string[]
}

export const LayoutWsContext = createContext<LayoutWsContextValue | null>(null)

/** Pure core of {@link useAppHashInContext}, split out for direct testing
 *  and for loop/conditional call sites where the hook can't run per item.
 *  With a provided session context, build directly (the same-workspace
 *  drop rule is the one equality; buildLayoutFromSlots canonicalizes the
 *  entries exactly as the parse path would); with none, defer to the
 *  render-time global-hash read. */
export const appHashForSession = (
  provided: LayoutWsContextValue | null,
  workspaceId: string,
  blockId?: string,
): string =>
  provided === null
    ? buildAppHashInContext(workspaceId, blockId)
    : buildLayoutFromSlots(
      workspaceId,
      blockId ? [{kind: 'leaf', blockId}] : [],
      provided.workspaceId === workspaceId ? provided.wsContext : undefined,
    )

/** `buildAppHashInContext` for components: same-workspace lane context
 *  comes from the RENDERING session's provider when one is mounted, else
 *  from the current global hash (see {@link LayoutWsContext}). In-app
 *  anchor components use this instead of calling buildAppHashInContext
 *  directly. */
export const useAppHashInContext = (workspaceId: string, blockId?: string): string =>
  appHashForSession(useContext(LayoutWsContext), workspaceId, blockId)
