import { Block } from "../../data/block.js";
import { actionContextsFacet, actionsFacet } from "../../extensions/core.js";
import { shortcutSurfaceActivationsFacet } from "../../extensions/blockInteraction.js";
//#region src/plugins/backlinks/backlinkBreadcrumbShortcuts.ts
var BACKLINK_ENTRY_ACTION_CONTEXT = "backlinks.entry";
var BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY = "backlinks.entryShortcutController";
var isRecord = (value) => typeof value === "object" && value !== null;
var isBacklinkEntryShortcutController = (value) => isRecord(value) && typeof value.promoteClosestBreadcrumb === "function" && typeof value.hasBreadcrumb === "function";
var isBacklinkEntryShortcutDependencies = (value) => isRecord(value) && value.block instanceof Block && value.uiStateBlock instanceof Block && typeof value.promoteClosestBreadcrumb === "function" && typeof value.hasBreadcrumb === "function";
var toBacklinkEntryShortcutDependencies = (value) => value;
var backlinkEntryShortcutContextOverrides = (controller) => ({ [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller });
var promoteClosestBreadcrumb = (parents, setShownBlockId) => {
	const target = parents.at(-1);
	if (!target) return false;
	setShownBlockId(target.id);
	return true;
};
var backlinkEntryActionContext = {
	type: BACKLINK_ENTRY_ACTION_CONTEXT,
	displayName: "Backlink Entry",
	validateDependencies: isBacklinkEntryShortcutDependencies
};
var promoteClosestBreadcrumbAction = {
	id: "backlinks.promote_closest_breadcrumb",
	description: "Promote closest backlink breadcrumb",
	context: BACKLINK_ENTRY_ACTION_CONTEXT,
	handler: (dependencies) => {
		toBacklinkEntryShortcutDependencies(dependencies).promoteClosestBreadcrumb?.();
	},
	isVisible: (dependencies) => {
		return toBacklinkEntryShortcutDependencies(dependencies).hasBreadcrumb?.() === true;
	},
	defaultBinding: { keys: "Alt+z" }
};
var backlinkEntryShortcutActivation = (context) => {
	if (context.surface !== "block" || !context.inFocus || context.inEditMode || context.isSelected || context.blockContext?.isBacklink !== true) return null;
	const controller = context.blockContext[BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY];
	if (!isBacklinkEntryShortcutController(controller)) return null;
	return [{
		context: BACKLINK_ENTRY_ACTION_CONTEXT,
		dependencies: {
			block: context.block,
			promoteClosestBreadcrumb: controller.promoteClosestBreadcrumb,
			hasBreadcrumb: controller.hasBreadcrumb
		}
	}];
};
var backlinkBreadcrumbShortcutsExtension = [
	actionContextsFacet.of(backlinkEntryActionContext, { source: "backlinks" }),
	actionsFacet.of(promoteClosestBreadcrumbAction, { source: "backlinks" }),
	shortcutSurfaceActivationsFacet.of(backlinkEntryShortcutActivation, { source: "backlinks" })
];
//#endregion
export { BACKLINK_ENTRY_ACTION_CONTEXT, BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY, backlinkBreadcrumbShortcutsExtension, backlinkEntryActionContext, backlinkEntryShortcutActivation, backlinkEntryShortcutContextOverrides, isBacklinkEntryShortcutController, promoteClosestBreadcrumb, promoteClosestBreadcrumbAction };

//# sourceMappingURL=backlinkBreadcrumbShortcuts.js.map