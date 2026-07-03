import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
//#region src/plugins/todo/schema.ts
var TODO_TYPE = "todo";
var statusProp = defineProperty("status", {
	codec: codecs.enum(["open", "done"]),
	defaultValue: "open",
	changeScope: ChangeScope.BlockDefault
});
var roamTodoStateProp = defineProperty("roam:todo-state", {
	codec: codecs.enum(["TODO", "DONE"]),
	defaultValue: "TODO",
	changeScope: ChangeScope.BlockDefault
});
var todoType = defineBlockType({
	id: TODO_TYPE,
	label: "Todo",
	properties: [statusProp]
});
//#endregion
export { TODO_TYPE, roamTodoStateProp, statusProp, todoType };

//# sourceMappingURL=schema.js.map