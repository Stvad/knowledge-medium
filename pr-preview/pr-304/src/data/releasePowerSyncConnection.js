//#region src/data/releasePowerSyncConnection.ts
var releasePowerSyncConnection = async (db) => {
	try {
		await db.close();
	} catch {
		try {
			await db.database.close();
		} catch (adapterErr) {
			console.warn("[db-recovery] adapter close fallback failed after close() rejected:", adapterErr);
		}
	}
};
//#endregion
export { releasePowerSyncConnection };

//# sourceMappingURL=releasePowerSyncConnection.js.map