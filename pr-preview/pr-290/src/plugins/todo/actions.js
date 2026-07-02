import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { getBlockTypes } from "../../data/properties.js";
import { actionsFacet } from "../../extensions/core.js";
import { TODO_TYPE, statusProp } from "./schema.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from "../swipe-quick-actions/actions.js";
//#region src/plugins/todo/actions.ts
var TODO_CYCLE_ACTION_ID = "todo.cycle";
var EDIT_MODE_TODO_CYCLE_ACTION_ID = "edit.cm.todo.cycle";
var TODO_TOGGLE_KEYS = ["$mod+Enter"];
var readStatus = (properties) => {
	const stored = properties[statusProp.name];
	if (stored === void 0) return statusProp.defaultValue;
	return statusProp.codec.decode(stored);
};
var clearStatusInTx = async (block) => {
	await block.repo.tx(async (tx) => {
		if (!await tx.get(block.id)) return;
		await block.repo.removeTypeInTx(tx, block.id, TODO_TYPE);
		const updated = await tx.get(block.id);
		if (!updated) return;
		const next = { ...updated.properties };
		delete next[statusProp.name];
		await tx.update(block.id, { properties: next });
	}, {
		scope: ChangeScope.BlockDefault,
		description: "cycle todo state"
	});
};
var cycleTodoState = async (block) => {
	if (block.repo.isReadOnly) return;
	const row = block.peek() ?? await block.load();
	if (!row) return;
	if (!getBlockTypes(row).includes("todo")) {
		await block.repo.tx(async (tx) => {
			await block.repo.addTypeInTx(tx, block.id, TODO_TYPE, { [statusProp.name]: "open" });
			await tx.setProperty(block.id, statusProp, "open");
		}, {
			scope: ChangeScope.BlockDefault,
			description: "cycle todo state"
		});
		return;
	}
	if (readStatus(row.properties) !== "done") {
		await block.set(statusProp, "done");
		return;
	}
	await clearStatusInTx(block);
};
var createTodoCycleAction = (context, id, description) => ({
	id,
	description,
	context,
	handler: (async ({ block }) => {
		await cycleTodoState(block);
	}),
	defaultBinding: {
		keys: TODO_TOGGLE_KEYS,
		eventOptions: { preventDefault: true }
	}
});
var todoActions = [
	createTodoCycleAction(ActionContextTypes.NORMAL_MODE, TODO_CYCLE_ACTION_ID, "Cycle todo state"),
	createTodoCycleAction(ActionContextTypes.EDIT_MODE_CM, EDIT_MODE_TODO_CYCLE_ACTION_ID, "Cycle todo state (Edit Mode)"),
	{
		id: SWIPE_RIGHT_BLOCK_ACTION_ID,
		description: "Swipe right: cycle todo state",
		context: ActionContextTypes.NORMAL_MODE,
		gestureBinding: { gesture: "swipe-right" },
		handler: async ({ block }) => {
			await cycleTodoState(block);
		}
	}
];
var todoActionsExtension = todoActions.map((action) => actionsFacet.of(action, { source: "todo" }));
//#endregion
export { EDIT_MODE_TODO_CYCLE_ACTION_ID, TODO_CYCLE_ACTION_ID, cycleTodoState, todoActions, todoActionsExtension };

//# sourceMappingURL=actions.js.map