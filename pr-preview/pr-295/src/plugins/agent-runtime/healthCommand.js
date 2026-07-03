import { materializeQueueCountSql, uploadQueueCountCap, uploadQueuePreviewCountSql } from "../system-status/queueCounts.js";
//#region src/plugins/agent-runtime/healthCommand.ts
var countOf = async (repo, sql) => (await repo.db.get(sql)).count;
var runHealthCommand = async (repo) => {
	const [blocks, blocksSynced, uploadQueueBlocks, materializeBacklog] = await Promise.all([
		countOf(repo, "SELECT count(*) AS count FROM blocks WHERE deleted = 0"),
		countOf(repo, "SELECT count(*) AS count FROM blocks_synced WHERE deleted = 0"),
		countOf(repo, uploadQueuePreviewCountSql),
		countOf(repo, materializeQueueCountSql)
	]);
	return {
		activeWorkspaceId: repo.activeWorkspaceId,
		blocks,
		blocksSynced,
		uploadQueueBlocks,
		uploadQueueApproximate: uploadQueueBlocks > uploadQueueCountCap,
		materializeBacklog
	};
};
//#endregion
export { runHealthCommand };

//# sourceMappingURL=healthCommand.js.map