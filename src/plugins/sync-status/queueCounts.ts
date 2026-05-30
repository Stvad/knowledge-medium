export const uploadQueueCountCap = 1000
export const uploadQueuePreviewCountSql =
  `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ps_crud LIMIT ${uploadQueueCountCap + 1})`
export const uploadQueueExactCountSql = 'SELECT COUNT(*) AS count FROM ps_crud'

export const formatPendingChanges = (
  count: number,
  localOnly: boolean,
  approximate = false,
): string => {
  if (count <= 0) return 'No unsynced changes'
  const noun = count === 1 && !approximate ? 'change' : 'changes'
  const countLabel = approximate ? `${count.toLocaleString()}+` : count.toLocaleString()
  const suffix = localOnly ? 'stored locally' : 'queued for upload'
  return `${countLabel} ${noun} ${suffix}`
}
