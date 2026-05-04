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
  const trimmedWithParams = hash.startsWith('#') ? hash.slice(1) : hash
  const trimmed = trimmedWithParams.split('?', 1)[0]
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
