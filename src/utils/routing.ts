// URL hash format: #<workspaceId>/<blockId1>/<blockId2>/...
//
// Ids are UUIDs (text). An empty hash means "use the user's last-active
// workspace from localStorage, falling back to the first synced workspace".
// A hash with only a workspace id (no `/`) means "restore or create the
// workspace's tab-local panel layout".
//
// Phase 2 drops support for legacy hashes (`#<blockId>` without a workspace
// id). The previous data is disposable per the workspace migration, so any
// bookmarked legacy URL won't resolve to a real block anyway.

export interface AppRoute {
  workspaceId?: string
  blockId?: string
}

export interface AppLayoutRoute {
  workspaceId?: string
  blockIds: string[]
}

export const parseLayout = (hash: string | undefined | null): AppLayoutRoute => {
  if (!hash) return {blockIds: []}
  const trimmedWithParams = hash.startsWith('#') ? hash.slice(1) : hash
  const trimmed = trimmedWithParams.split('?', 1)[0]
  if (!trimmed) return {blockIds: []}

  const [workspaceId, ...blockIds] = trimmed.split('/')
  return {
    workspaceId: workspaceId || undefined,
    blockIds: blockIds.filter(Boolean),
  }
}

export const buildLayout = (workspaceId: string, blockIds: readonly string[] = []): string =>
  blockIds.length > 0 ? `#${workspaceId}/${blockIds.join('/')}` : `#${workspaceId}`

export const layoutWorkspaceChanged = (
  previousHash: string | undefined | null,
  nextHash: string | undefined | null,
): boolean =>
  parseLayout(previousHash).workspaceId !== parseLayout(nextHash).workspaceId

export const parseAppHash = (hash: string | undefined | null): AppRoute => {
  const {workspaceId, blockIds} = parseLayout(hash)
  if (!workspaceId) return {}
  return {
    workspaceId,
    blockId: blockIds[0],
  }
}

export const buildAppHash = (workspaceId: string, blockId?: string): string =>
  buildLayout(workspaceId, blockId ? [blockId] : [])
