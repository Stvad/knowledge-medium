//#region src/plugins/system-status/queueCounts.ts
var uploadQueueCountCap = 1e3;
var uploadQueuePreviewCountSql = `SELECT COUNT(*) AS count FROM (SELECT DISTINCT json_extract(data, '$.id') FROM ps_crud LIMIT ${uploadQueueCountCap + 1})`;
var uploadQueueExactCountSql = `SELECT COUNT(DISTINCT json_extract(data, '$.id')) AS count FROM ps_crud`;
var materializeQueueCountSql = "SELECT COUNT(*) AS count FROM blocks_synced_changes";
var formatPendingChanges = (count, localOnly, approximate = false) => {
	if (count <= 0) return "No unsynced changes";
	const noun = count === 1 && !approximate ? "block" : "blocks";
	return `${approximate ? `${count.toLocaleString()}+` : count.toLocaleString()} ${noun} ${localOnly ? "changed, stored locally" : "changed, queued for upload"}`;
};
//#endregion
export { formatPendingChanges, materializeQueueCountSql, uploadQueueCountCap, uploadQueueExactCountSql, uploadQueuePreviewCountSql };

//# sourceMappingURL=queueCounts.js.map