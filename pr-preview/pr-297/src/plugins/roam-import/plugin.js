import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appEffectsFacet } from "../../extensions/core.js";
import { importRoamAction } from "./action.js";
import { roamImportWindowHookEffect } from "./effect.js";
//#region src/plugins/roam-import/plugin.ts
var roamImportPlugin = ({ repo }) => systemToggle({
	id: "system:roam-import",
	name: "Roam import",
	description: "Import a Roam .json export into the current workspace."
}).of([actionsFacet.of(importRoamAction({ repo }), { source: "roam-import" }), appEffectsFacet.of(roamImportWindowHookEffect, { source: "roam-import" })]);
//#endregion
export { roamImportPlugin };

//# sourceMappingURL=plugin.js.map