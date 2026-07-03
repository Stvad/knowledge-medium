import { applyToggle } from "../../facets/togglable.js";
import { showError } from "../../utils/toast.js";
import { useRepo } from "../../context/repo.js";
import { refreshAppRuntime } from "../../facets/runtimeEvents.js";
import { lookupApproval } from "../../extensions/compileExtensionModule.js";
import { approveExtensionHere } from "../../extensions/approveExtensionHere.js";
import { extensionsOverridesProp } from "./config.js";
import { ExtensionsSettings } from "./ExtensionsSettings.js";
import { useToggleTree } from "./useToggleTree.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/extensions-settings/ExtensionsOverridesEditor.tsx
var ExtensionsOverridesEditor = (t0) => {
	const $ = c(14);
	const { value, block } = t0;
	const repo = useRepo();
	const { tree, loading, workspaceId } = useToggleTree();
	const prefsBlock = block;
	let t1;
	if ($[0] !== repo) {
		t1 = (handle) => approveExtensionHere(repo, handle.id, handle.name);
		$[0] = repo;
		$[1] = t1;
	} else t1 = $[1];
	const approveHere = t1;
	let t2;
	if ($[2] !== approveHere || $[3] !== prefsBlock) {
		t2 = (handle_0, nextState) => {
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
				} catch (t3) {
					const error = t3;
					console.error(`Failed to write extensions intent for ${handle_0.id}`, error);
					showError(`Couldn't ${nextState ? "enable" : "disable"} "${handle_0.name}" — the change couldn't be saved.`);
				}
			})();
		};
		$[2] = approveHere;
		$[3] = prefsBlock;
		$[4] = t2;
	} else t2 = $[4];
	const handleToggle = t2;
	let t3;
	if ($[5] !== approveHere) {
		t3 = (handle_1) => {
			(async () => {
				if (await approveHere(handle_1)) refreshAppRuntime();
			})();
		};
		$[5] = approveHere;
		$[6] = t3;
	} else t3 = $[6];
	const handleApprove = t3;
	if (loading) {
		let t4;
		if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
			t4 = /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: "Loading extensions…"
			});
			$[7] = t4;
		} else t4 = $[7];
		return t4;
	}
	let t4;
	if ($[8] !== handleApprove || $[9] !== handleToggle || $[10] !== tree || $[11] !== value || $[12] !== workspaceId) {
		t4 = /* @__PURE__ */ jsx(ExtensionsSettings, {
			tree,
			overrides: value,
			onToggle: handleToggle,
			onApprove: handleApprove,
			workspaceId
		});
		$[8] = handleApprove;
		$[9] = handleToggle;
		$[10] = tree;
		$[11] = value;
		$[12] = workspaceId;
		$[13] = t4;
	} else t4 = $[13];
	return t4;
};
//#endregion
export { ExtensionsOverridesEditor };

//# sourceMappingURL=ExtensionsOverridesEditor.js.map