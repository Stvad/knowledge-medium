import { showPropertiesProp } from "../data/properties.js";
import { requestPropertyCreate } from "./propertyNavigation.js";
//#region src/utils/propertyCreation.ts
var convertEmptyChildBlockToProperty = async (block, repo) => {
	if (repo.isReadOnly) return false;
	const parentId = (block.peek() ?? await block.load())?.parentId;
	if (!parentId) return false;
	if ((await block.childIds.load()).length > 0) return false;
	await repo.block(parentId).set(showPropertiesProp, true);
	requestPropertyCreate({ blockId: parentId });
	await block.delete();
	return true;
};
//#endregion
export { convertEmptyChildBlockToProperty };

//# sourceMappingURL=propertyCreation.js.map