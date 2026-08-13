// Queue-count SQL lives in core: @/data/syncQueueSql.ts (uploadQueueCountCap,
// uploadQueuePreviewCountSql, uploadQueueExactCountSql, materializeQueueCountSql,
// rejectedQueueCountSql, uploadQueueRowCountSql). It moved out of this plugin
// because src/utils/dbForensicsHooks.ts (core) needs the same SQL for the
// sync-health breadcrumb sampler, and core cannot import from src/plugins/**
// (boundary/no-core-to-plugin-imports).

export const formatPendingChanges = (
  count: number,
  localOnly: boolean,
  approximate = false,
): string => {
  if (count <= 0) return 'No unsynced changes'
  const noun = count === 1 && !approximate ? 'block' : 'blocks'
  const countLabel = approximate ? `${count.toLocaleString()}+` : count.toLocaleString()
  const suffix = localOnly ? 'changed, stored locally' : 'changed, queued for upload'
  return `${countLabel} ${noun} ${suffix}`
}
