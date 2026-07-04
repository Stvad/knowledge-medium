//#region src/plugins/attachments/uploadReconcile.ts
var reconcileUploads = async (userId, deps) => {
	const staged = await deps.store.listByStatus(userId, "staged");
	let promoted = 0;
	let kept = 0;
	for (const rec of staged) if (await deps.isBlockPresent(rec.workspaceId, rec.assetBlockId)) {
		await deps.store.promote(userId, rec.assetBlockId);
		promoted += 1;
	} else kept += 1;
	return {
		promoted,
		kept
	};
};
//#endregion
export { reconcileUploads };

//# sourceMappingURL=uploadReconcile.js.map