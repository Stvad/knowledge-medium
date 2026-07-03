import { truncate } from "../../utils/string.js";
import { AliasCollisionToast } from "./AliasCollisionToast.js";
import { createElement } from "react";
//#region src/plugins/alias/rejectionToast.tsx
/**
* Alias plugin's toast for its own `alias.collision` ProcessorRejection.
*
* The alias.sync same-tx processor throws `ProcessorRejection {code:
* 'alias.collision', meta}` when a block tries to claim an alias already
* held by a different live block. This module owns everything the *user*
* sees for that rejection — the meta shape, the copy, and the actionable
* `AliasCollisionToast` — and contributes it through the generic
* `rejectionToastFacet`. Core (`extensions/processorRejectionToast`) stays
* ignorant of `alias.collision`: it just renders whatever the registered
* contribution returns, inside its own `showCustom` envelope.
*/
var isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var isAliasCollisionMeta = (meta) => meta !== null && typeof meta === "object" && typeof meta.alias === "string" && typeof meta.conflictingBlockId === "string" && typeof meta.conflictingBlockTitle === "string" && typeof meta.workspaceId === "string" && typeof meta.attemptedOn === "string" && (meta.dropSourceAliases === void 0 || isStringArray(meta.dropSourceAliases)) && (meta.collisionOrigin === void 0 || typeof meta.collisionOrigin === "string");
/** `rejectionToastFacet` contribution for `alias.collision`. */
var aliasCollisionRejectionToast = {
	code: "alias.collision",
	render: (error, repo, toastId) => {
		if (!isAliasCollisionMeta(error.meta)) return createElement("span", null, error.message);
		const { alias, attemptedOn, conflictingBlockId, conflictingBlockTitle, workspaceId, dropSourceAliases, collisionOrigin } = error.meta;
		const displayTitle = conflictingBlockTitle.trim() === "" ? `"${alias}"` : `"${truncate(conflictingBlockTitle, 60)}"`;
		const offerMerge = collisionOrigin !== "create";
		return createElement(AliasCollisionToast, {
			toastId,
			message: offerMerge ? `Alias "${alias}" is already used by ${displayTitle}. Your edit was reverted — try a different name or merge with the existing page.` : `Alias "${alias}" is already used by ${displayTitle}. Nothing was created — try a different name.`,
			alias,
			attemptedOn,
			conflictingBlockId,
			conflictingBlockTitle,
			workspaceId,
			dropSourceAliases,
			offerMerge,
			repo
		});
	}
};
//#endregion
export { aliasCollisionRejectionToast };

//# sourceMappingURL=rejectionToast.js.map