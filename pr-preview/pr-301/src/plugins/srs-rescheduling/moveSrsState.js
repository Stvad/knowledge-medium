import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { getBlockTypes } from "../../data/properties.js";
import { SRS_SM25_TYPE, srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSnapshotHistoryProp } from "./schema.js";
//#region src/plugins/srs-rescheduling/moveSrsState.ts
var SRS_PROPERTY_NAMES = [
	srsIntervalProp.name,
	srsFactorProp.name,
	srsNextReviewDateProp.name,
	srsReviewCountProp.name,
	srsGradeProp.name,
	srsArchivedProp.name,
	srsSnapshotHistoryProp.name
];
/** Move the SRS SM-2.5 type and all SRS field values from one block to
*  another, in a single transaction. After the move the source block no
*  longer has the SRS type and none of the SRS fields, and the target
*  has exactly the SRS state the source had (any prior SRS state on the
*  target is wholly replaced — this is move, not merge). */
var moveSrsState = async (repo, sourceBlockId, targetBlockId) => {
	if (sourceBlockId === targetBlockId) return;
	if (repo.isReadOnly) return;
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const source = await tx.get(sourceBlockId);
		if (!source) return;
		if (!getBlockTypes(source).includes("srs-sm2.5")) return;
		const target = await tx.get(targetBlockId);
		if (!target) return;
		const moved = {};
		for (const name of SRS_PROPERTY_NAMES) {
			const encoded = source.properties[name];
			if (encoded !== void 0) moved[name] = encoded;
		}
		if (!getBlockTypes(target).includes("srs-sm2.5")) await repo.addTypeInTx(tx, targetBlockId, SRS_SM25_TYPE, {}, typeSnapshot);
		const targetAfter = await tx.get(targetBlockId);
		if (!targetAfter) return;
		const nextTarget = { ...targetAfter.properties };
		for (const name of SRS_PROPERTY_NAMES) delete nextTarget[name];
		for (const [name, value] of Object.entries(moved)) nextTarget[name] = value;
		await tx.update(targetBlockId, { properties: nextTarget });
		await repo.removeTypeInTx(tx, sourceBlockId, SRS_SM25_TYPE);
		const sourceAfter = await tx.get(sourceBlockId);
		if (!sourceAfter) return;
		const nextSource = { ...sourceAfter.properties };
		let changed = false;
		for (const name of SRS_PROPERTY_NAMES) if (nextSource[name] !== void 0) {
			delete nextSource[name];
			changed = true;
		}
		if (changed) await tx.update(sourceBlockId, { properties: nextSource });
	}, {
		scope: ChangeScope.BlockDefault,
		description: "srs move state"
	});
};
//#endregion
export { moveSrsState };

//# sourceMappingURL=moveSrsState.js.map