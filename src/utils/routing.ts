// URL hash format: #<workspaceId>/<blockId>
//
// Both ids are UUIDs (text). An empty hash means "use the user's last-active
// workspace from localStorage, falling back to the first synced workspace".
// A hash with only a workspace id (no `/`) means "land on the workspace's
// root block".
//
// Phase 2 drops support for legacy hashes (`#<blockId>` without a workspace
// id). The previous data is disposable per the workspace migration, so any
// bookmarked legacy URL won't resolve to a real block anyway.

export interface AppRoute {
  workspaceId?: string
  blockId?: string
}

export const parseAppHash = (hash: string | undefined | null): AppRoute => {
  if (!hash) return {}
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  if (!trimmed) return {}

  const [workspaceId, blockId] = trimmed.split('/', 2)
  return {
    workspaceId: workspaceId || undefined,
    blockId: blockId || undefined,
  }
}

export const buildAppHash = (workspaceId: string, blockId?: string): string =>
  blockId ? `#${workspaceId}/${blockId}` : `#${workspaceId}`

export const writeAppHash = (workspaceId: string, blockId?: string): void => {
  const next = buildAppHash(workspaceId, blockId)
  if (window.location.hash !== next) {
    window.location.hash = next
  }
}

// In-app block navigation (zoom-in, breadcrumb, bullet-link). The block lives
// in some workspace; the hash needs the `<workspaceId>/<blockId>` shape so
// App.tsx's bootstrap can resolve it. Callers pass `workspaceId` explicitly
// (almost always `repo.activeWorkspaceId` since cross-workspace embedding
// isn't a thing yet) — if it's missing we fall back to a bare `#<blockId>`,
// which will NOT resolve cleanly under the new scheme but is still better
// than crashing the renderer mid-render.
export const buildBlockHash = (
  workspaceId: string | null | undefined,
  blockId: string,
): string => (workspaceId ? buildAppHash(workspaceId, blockId) : `#${blockId}`)
