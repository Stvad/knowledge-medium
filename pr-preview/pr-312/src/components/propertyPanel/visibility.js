import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
//#region src/components/propertyPanel/visibility.ts
/**
* Property-panel visibility policy. Prefer propertyEditorOverridesFacet
* metadata so plugins/kernel UI can mark internal fields without
* BlockProperties importing individual schemas. The scope/name fallbacks
* keep dynamic and legacy system properties hidden even without an
* override.
*/
var isPropertyPanelHiddenProperty = (name, schemas, uis) => {
	const schema = schemas.get(name);
	return uis.get(name)?.hidden === true || name.startsWith("system:") || schema?.changeScope === ChangeScope.UiState;
};
//#endregion
export { isPropertyPanelHiddenProperty };

//# sourceMappingURL=visibility.js.map