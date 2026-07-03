import { applyToggle } from "../../facets/togglable.js";
import { showError } from "../../utils/toast.js";
import { useRepo } from "../../context/repo.js";
import { refreshAppRuntime } from "../../facets/runtimeEvents.js";
import { approveExtension, lookupApproval } from "../../extensions/compileExtensionModule.js";
import { extensionsOverridesProp } from "./config.js";
import { ExtensionsSettings } from "./ExtensionsSettings.js";
import { useToggleTree } from "./useToggleTree.js";
import { useCallback } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/extensions-settings/ExtensionsOverridesEditor.tsx
/**
* Property editor for `extensions:overrides`.
*
* Renders inside the property panel of the Extensions prefs block.
* Composes:
*   - `useToggleTree()` — walks the full extension tree (static +
*     dynamic) into a discoverable forest
*   - `<ExtensionsSettings>` — the presentational checkbox tree
*   - `block.set(extensionsOverridesProp, updater)` — a read-modify-write
*     of the synced INTENT map inside the serialized write-tx, so two
*     overlapping toggles (whose first-enable approvals run async) can't
*     each compute from a stale snapshot and drop one another's intent.
*
* Two-layer enable model (issue #67): the synced overrides map is the
* cross-device INTENT; whether a user extension actually runs is gated by
* a device-local TRUST grant (an approval pinned to the source hash).
*   - enabling a user extension grants device-local trust the FIRST time
*     (approves the live source) and sets intent true. If it was already
*     approved, the existing pin is kept — a since-synced source change
*     surfaces as "update-available", never auto-adopted on a checkbox
*     click.
*   - disabling only flips intent off; the trust grant persists, so
*     re-enabling is frictionless and still pinned. Disable propagates
*     across devices through the intent gate alone.
*   - "Enable here" (approved nowhere here yet) / "Update" (source drifted)
*     are the EXPLICIT trust actions — they always (re-)approve the live
*     source, then dispatch a refresh so the loader re-resolves.
* System (built-in) toggles are intent-only.
*/
var ExtensionsOverridesEditor = ({ value, block }) => {
	const repo = useRepo();
	const { tree, loading, workspaceId } = useToggleTree();
	const prefsBlock = block;
	const approveHere = useCallback(async (handle) => {
		const block_0 = await repo.load(handle.id);
		if (!block_0) {
			showError(`Couldn't enable "${handle.name}" — its definition block wasn't found.`);
			return false;
		}
		try {
			await approveExtension(handle.id, block_0.content ?? "");
			return true;
		} catch (error) {
			console.error(`Failed to approve extension ${handle.id}`, error);
			showError(`Couldn't enable "${handle.name}" — ${error instanceof Error ? error.message : "approval could not be saved"}.`);
			return false;
		}
	}, [repo]);
	const handleToggle = useCallback((handle_0, nextState) => {
		(async () => {
			if (handle_0.kind === "user" && nextState) {
				const approval = await lookupApproval(handle_0.id);
				if (approval.status === "unreadable") {
					showError(`Couldn't enable "${handle_0.name}" — couldn't read its approval state. Try again.`);
					return;
				}
				if (approval.status === "unapproved" && !await approveHere(handle_0)) return;
			}
			try {
				await prefsBlock.set(extensionsOverridesProp, (current) => applyToggle(current ?? /* @__PURE__ */ new Map(), handle_0, nextState));
			} catch (error_0) {
				console.error(`Failed to write extensions intent for ${handle_0.id}`, error_0);
				showError(`Couldn't ${nextState ? "enable" : "disable"} "${handle_0.name}" — the change couldn't be saved.`);
			}
		})();
	}, [approveHere, prefsBlock]);
	const handleApprove = useCallback((handle_1) => {
		(async () => {
			if (await approveHere(handle_1)) refreshAppRuntime();
		})();
	}, [approveHere]);
	if (loading) return /* @__PURE__ */ jsx("p", {
		className: "text-sm text-muted-foreground",
		children: "Loading extensions…"
	});
	return /* @__PURE__ */ jsx(ExtensionsSettings, {
		tree,
		overrides: value,
		onToggle: handleToggle,
		onApprove: handleApprove,
		workspaceId
	});
};
//#endregion
export { ExtensionsOverridesEditor };

//# sourceMappingURL=ExtensionsOverridesEditor.js.map