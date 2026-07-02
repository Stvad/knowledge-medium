import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { locationProp } from "./properties.js";
import { LocationPropertyEditor } from "./LocationPropertyEditor.js";
//#region src/plugins/geo/propertyEditorOverrides.ts
/** Per-name property editor overrides exposed by the geo plugin. Only
*  the `location` property needs one — the codec-based default editor
*  for refs (`RefPropertyEditor`) doesn't know how to call out to
*  Google Places. */
var locationPropertyEditorOverride = definePropertyEditorOverride({
	name: locationProp.name,
	label: "Location",
	Editor: LocationPropertyEditor
});
//#endregion
export { locationPropertyEditorOverride };

//# sourceMappingURL=propertyEditorOverrides.js.map