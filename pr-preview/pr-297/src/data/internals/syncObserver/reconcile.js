//#region src/data/internals/syncObserver/reconcile.ts
/**
* Decide what to do with one inserted/updated staging row.
*
* The gate's input is now trustworthy: the server enforces `updated_at`
* monotonicity (an unconditional floor + a +1 bump on any content change), so
* a staging row's stamp is a reliable row-version. That collapses the old
* strict/healing + provenance machinery to three cases.
*
* @param materializability how the row's workspace can be materialized
* @param stagingUpdatedAt  `updated_at` (row-version) of the incoming staging row
* @param local             local state for this block id
*/
var decideStagingRow = (materializability, stagingUpdatedAt, local) => {
	if (materializability === "defer") return { kind: "defer" };
	if (local.hasPendingUpload) return { kind: "skip-stale" };
	if (local.localUpdatedAt !== null && local.localUpdatedAt === stagingUpdatedAt && local.localUpdatedAt !== 0) return { kind: "skip-stale" };
	return {
		kind: "apply",
		decrypt: materializability === "decrypt"
	};
};
//#endregion
export { decideStagingRow };

//# sourceMappingURL=reconcile.js.map