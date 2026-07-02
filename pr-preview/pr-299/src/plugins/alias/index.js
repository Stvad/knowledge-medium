import { systemToggle } from "../../facets/togglable.js";
import { ALIAS_COLLISION_MERGE_MUTATOR, aliasCollisionMerge } from "./collisionMerge.js";
import { ALIAS_SYNC_PROCESSOR, aliasSyncProcessor } from "./syncProcessor.js";
import { aliasDataExtension } from "./dataExtension.js";
import { rejectionToastFacet } from "../../extensions/core.js";
import { aliasCollisionRejectionToast } from "./rejectionToast.js";
//#region src/plugins/alias/index.ts
var aliasPlugin = systemToggle({
	id: "system:alias",
	name: "Aliases",
	description: "Alias property + sync processor so blocks can be referenced by name."
}).of([aliasDataExtension, rejectionToastFacet.of(aliasCollisionRejectionToast, { source: "alias" })]);
//#endregion
export { ALIAS_COLLISION_MERGE_MUTATOR, ALIAS_SYNC_PROCESSOR, aliasCollisionMerge, aliasDataExtension, aliasPlugin, aliasSyncProcessor };

//# sourceMappingURL=index.js.map