import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { KEYBINDING_OVERRIDE_USER_SOURCE, keybindingOverridesFacet } from "../../shortcuts/keybindingOverrides.js";
import { keybindingOverridesProp, keybindingsPrefsType } from "./config.js";
//#region src/plugins/keybindings-settings/effect.ts
var readOverridesFromBlock = (block) => {
	try {
		return block.peekProperty(keybindingOverridesProp) ?? [];
	} catch (error) {
		console.error("Keybindings: overrides property is malformed; falling back to \"no overrides\". Repair via settings or manually edit the Keyboard shortcuts block.", error);
		return [];
	}
};
var toFacetEntry = (entry) => ({
	actionId: entry.actionId,
	context: entry.context,
	binding: entry.binding,
	source: KEYBINDING_OVERRIDE_USER_SOURCE
});
/** Push the stored overrides into the facet's runtime bucket. The
*  facet runtime invalidates its cache and fires per-facet listeners,
*  which `HotkeyReconciler` listens to and uses to re-run
*  `getEffectiveActions`. */
var pushOverridesToRuntime = (runtime, stored) => {
	runtime.setRuntimeContributions(keybindingOverridesFacet, KEYBINDING_OVERRIDE_USER_SOURCE, stored.map(toFacetEntry));
};
var keybindingsSyncEffect = {
	id: "keybindings.sync-runtime",
	start: ({ repo, runtime, workspaceId }) => {
		let disposed = false;
		let unsubscribe;
		(async () => {
			const block = await getPluginPrefsBlock(repo, workspaceId, repo.user, keybindingsPrefsType);
			if (disposed) return;
			const push = () => pushOverridesToRuntime(runtime, readOverridesFromBlock(block));
			push();
			unsubscribe = block.subscribe(push);
		})().catch((error) => {
			console.error("Keybindings: failed to resolve prefs block; overrides will not sync until next session.", error);
		});
		return () => {
			disposed = true;
			unsubscribe?.();
			runtime.setRuntimeContributions(keybindingOverridesFacet, KEYBINDING_OVERRIDE_USER_SOURCE, []);
		};
	}
};
//#endregion
export { keybindingsSyncEffect, pushOverridesToRuntime, readOverridesFromBlock };

//# sourceMappingURL=effect.js.map