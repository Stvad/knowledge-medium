import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { LAZY_DEEP_IDLE, scheduleDeepIdle } from "../../utils/scheduleIdle.js";
import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
//#region src/plugins/update-indicator/loadTimes.ts
var previousLoadTimeProp = defineProperty("previousLoadTime", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.UserPrefs
});
var currentLoadTimeProp = defineProperty("currentLoadTime", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.UserPrefs
});
/** Per-plugin prefs sub-block for the update-indicator plugin. Records
*  the previous/current bundle-load timestamps so the indicator can tell
*  the user "a new build is live since you last loaded." */
var updateIndicatorPrefsType = defineBlockType({
	id: "update-indicator-prefs",
	label: "Update indicator",
	properties: [previousLoadTimeProp, currentLoadTimeProp]
});
var recordedLoadTimes = /* @__PURE__ */ new Map();
var recordUpdateIndicatorLoadTime = async (repo, workspaceId) => {
	const key = `${repo.instanceId}:${workspaceId}:${repo.user.id}`;
	const existing = recordedLoadTimes.get(key);
	if (existing) return existing;
	const record = (async () => {
		const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, updateIndicatorPrefsType);
		const previous = prefsBlock.peekProperty(currentLoadTimeProp) ?? 0;
		await repo.tx(async (tx) => {
			await tx.setProperty(prefsBlock.id, previousLoadTimeProp, previous);
			await tx.setProperty(prefsBlock.id, currentLoadTimeProp, Date.now());
		}, {
			scope: ChangeScope.UserPrefs,
			description: "update indicator load time"
		});
	})().catch((error) => {
		recordedLoadTimes.delete(key);
		throw error;
	});
	recordedLoadTimes.set(key, record);
	return record;
};
/** Schedule the load-time write off the cold-start critical path.
*  The indicator only needs to know "when did *the previous* load
*  finish" — it doesn't need to write *this* load's timestamp before
*  any rendering, just before the next reload. So pushing the SQL to
*  deep idle is correctness-preserving and removes the writeTransaction
*  + its `getUserPrefsBlock` ensure-tx from the bootstrap window. The
*  next-reload deadline is far off, so genuine idle (never near boot,
*  fine to skip a never-idle session) is the right cadence. */
var updateIndicatorLoadTimeEffect = {
	id: "update-indicator.load-time",
	start: ({ repo, workspaceId }) => {
		scheduleDeepIdle(() => {
			recordUpdateIndicatorLoadTime(repo, workspaceId);
		}, LAZY_DEEP_IDLE);
	}
};
//#endregion
export { currentLoadTimeProp, previousLoadTimeProp, recordUpdateIndicatorLoadTime, updateIndicatorLoadTimeEffect, updateIndicatorPrefsType };

//# sourceMappingURL=loadTimes.js.map