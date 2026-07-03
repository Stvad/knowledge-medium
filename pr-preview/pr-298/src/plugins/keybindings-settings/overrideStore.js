import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { KEYBINDING_OVERRIDE_USER_SOURCE } from "../../shortcuts/keybindingOverrides.js";
import { applyKeybindingOverrides } from "../../shortcuts/applyKeybindingOverrides.js";
import { keybindingOverridesProp, keybindingsPrefsType, overrideEntryKey } from "./config.js";
import { findKeybindingConflicts } from "../../shortcuts/keybindingConflicts.js";
//#region src/plugins/keybindings-settings/overrideStore.ts
/** One stored entry as the facet contribution the apply-overrides pass
*  consumes. The settings plugin's overrides are always user-source. */
var toFacetOverride = (entry) => ({
	actionId: entry.actionId,
	context: entry.context,
	binding: entry.binding,
	source: KEYBINDING_OVERRIDE_USER_SOURCE
});
var toFacetOverrides = (stored) => stored.map(toFacetOverride);
/** Replace (or add) the entry for one (context, actionId), keeping the
*  rest. A row is addressed by the composite key so two contexts can
*  hold overrides for the same action id. */
var withReplacedOverride = (stored, next) => {
	const key = overrideEntryKey(next.context, next.actionId);
	return [...stored.filter((e) => overrideEntryKey(e.context, e.actionId) !== key), next];
};
/** Drop the entry for one (context, actionId) — reset-to-default. */
var withRemovedOverride = (stored, actionId, context) => {
	const key = overrideEntryKey(context, actionId);
	return stored.filter((e) => overrideEntryKey(e.context, e.actionId) !== key);
};
/** Conflicts the proposed override would introduce, filtered to the ones
*  the proposed action participates in. `baseActions` are the actions
*  BEFORE overrides (`getActionsBeforeKeybindingOverrides`); `stored` is
*  the current user override set. Advisory: plugin-source overrides
*  aren't modelled here (they're rare), so this reflects user-vs-user and
*  user-vs-default clashes — the ones a manual rebind actually creates. */
var previewOverrideConflicts = (baseActions, stored, proposed) => {
	return findKeybindingConflicts(applyKeybindingOverrides(baseActions, toFacetOverrides(withReplacedOverride(stored, proposed)))).filter((conflict) => conflict.actions.some((a) => a.actionId === proposed.actionId && a.context === proposed.context));
};
var resolvePrefsBlock = async (repo) => {
	const workspaceId = repo.activeWorkspaceId;
	if (!workspaceId) throw new Error("keybinding overrides require an active workspace");
	return getPluginPrefsBlock(repo, workspaceId, repo.user, keybindingsPrefsType);
};
/** Bind (or rebind) one action, persisting to the user's prefs block. */
var setKeybindingOverride = async (repo, entry) => {
	await (await resolvePrefsBlock(repo)).set(keybindingOverridesProp, (current) => withReplacedOverride(current ?? [], entry));
};
/** Clear an action's override, restoring its default binding. */
var removeKeybindingOverride = async (repo, actionId, context) => {
	await (await resolvePrefsBlock(repo)).set(keybindingOverridesProp, (current) => withRemovedOverride(current ?? [], actionId, context));
};
/** Read the user's currently-stored overrides (defaults to empty; a
*  malformed snapshot surfaces as a throw the caller can catch). */
var readStoredOverrides = async (repo) => {
	return (await resolvePrefsBlock(repo)).peekProperty(keybindingOverridesProp) ?? [];
};
//#endregion
export { previewOverrideConflicts, readStoredOverrides, removeKeybindingOverride, setKeybindingOverride, toFacetOverride, toFacetOverrides, withRemovedOverride, withReplacedOverride };

//# sourceMappingURL=overrideStore.js.map