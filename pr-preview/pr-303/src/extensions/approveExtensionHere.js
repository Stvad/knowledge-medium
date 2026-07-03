import { showError } from "../utils/toast.js";
import { approveExtension } from "./compileExtensionModule.js";
//#region src/extensions/approveExtensionHere.ts
/**
* Approve (or re-approve) a user extension on THIS device: pin its live
* source so the loader will run it. This is the EXPLICIT device-local trust
* action shared by every "Enable here" / "Update" affordance — the settings
* toggle rows (`ExtensionsOverridesEditor`) AND the global prompt toast
* (`extensionPromptMount`).
*
* Keyed strictly by `blockId`: it loads THAT block's current content and
* approves THAT block. Nothing here is shared across extensions, so enabling
* one extension can never touch another's trust state — the guarantee the
* global surface needs to avoid the mis-keyed-dismissal bug.
*
* Returns whether trust was established. Surfaces a toast on failure (block
* missing / approval write failed) so callers can avoid setting "enabled"
* intent against a non-existent approval (which would silently loop on
* needs-approval — #67 review).
*/
var approveExtensionHere = async (repo, blockId, name) => {
	try {
		const block = await repo.load(blockId);
		if (!block) {
			showError(`Couldn't enable "${name}" — its definition block wasn't found.`);
			return false;
		}
		await approveExtension(blockId, block.content ?? "");
		return true;
	} catch (error) {
		console.error(`Failed to approve extension ${blockId}`, error);
		showError(`Couldn't enable "${name}" — ${error instanceof Error ? error.message : "approval could not be saved"}.`);
		return false;
	}
};
//#endregion
export { approveExtensionHere };

//# sourceMappingURL=approveExtensionHere.js.map