import { getBlockTypes } from "../../data/properties.js";
import { srsArchivedProp } from "./schema.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from "../swipe-quick-actions/actions.js";
import { EDIT_MODE_TODO_CYCLE_ACTION_ID, TODO_CYCLE_ACTION_ID } from "../todo/actions.js";
//#region src/plugins/srs-rescheduling/swipeRightDecorator.ts
var archiveSrsBlock = async (block) => {
	const data = block.peek() ?? await block.load();
	if (!data || !getBlockTypes(data).includes("srs-sm2.5")) return false;
	if (!block.repo.isReadOnly) await block.set(srsArchivedProp, true);
	return true;
};
var decorateActionToArchiveSrsBlock = (actionId, context) => ({
	actionId,
	...context ? { context } : {},
	wrap: async (deps, trigger, next) => {
		const block = deps.block;
		if (block && await archiveSrsBlock(block)) return;
		await next(deps, trigger);
	}
});
var srsSwipeRightDecorator = decorateActionToArchiveSrsBlock(SWIPE_RIGHT_BLOCK_ACTION_ID);
var srsTodoCycleDecorators = [decorateActionToArchiveSrsBlock(TODO_CYCLE_ACTION_ID, ActionContextTypes.NORMAL_MODE), decorateActionToArchiveSrsBlock(EDIT_MODE_TODO_CYCLE_ACTION_ID, ActionContextTypes.EDIT_MODE_CM)];
//#endregion
export { archiveSrsBlock, srsSwipeRightDecorator, srsTodoCycleDecorators };

//# sourceMappingURL=swipeRightDecorator.js.map