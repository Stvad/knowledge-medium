import { cn } from "../../lib/utils.js";
import { useHash } from "../../../node_modules/react-use/esm/useHash.js";
import { useIsLocalOnly } from "../Login.js";
import { useRepo } from "../../context/repo.js";
import { ChevronDown } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-down.js";
import { Eye } from "../../../node_modules/lucide-react/dist/esm/icons/eye.js";
import { Plus } from "../../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { Settings } from "../../../node_modules/lucide-react/dist/esm/icons/settings.js";
import { buildAppHash } from "../../utils/routing.js";
import { useActiveWorkspaceId, useMyWorkspaceRoles, useWorkspaces } from "../../hooks/useWorkspaces.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { forgetRememberedWorkspace } from "../../utils/lastWorkspace.js";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog.js";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/workspace/WorkspaceSwitcher.tsx
function WorkspaceSwitcher(t0) {
	const $ = c(63);
	let t1;
	if ($[0] !== t0) {
		t1 = t0 === void 0 ? {} : t0;
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const { triggerClassName } = t1;
	const repo = useRepo();
	const [, setHash] = useHash();
	const activeWorkspaceId = useActiveWorkspaceId();
	const { workspaces } = useWorkspaces();
	const { rolesByWorkspaceId } = useMyWorkspaceRoles();
	const localOnly = useIsLocalOnly();
	const [createOpen, setCreateOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	let t2;
	if ($[2] !== activeWorkspaceId || $[3] !== workspaces) {
		let t3;
		if ($[5] !== activeWorkspaceId) {
			t3 = (w) => w.id === activeWorkspaceId;
			$[5] = activeWorkspaceId;
			$[6] = t3;
		} else t3 = $[6];
		t2 = workspaces.find(t3);
		$[2] = activeWorkspaceId;
		$[3] = workspaces;
		$[4] = t2;
	} else t2 = $[4];
	const activeWorkspace = t2;
	const displayName = activeWorkspace?.name ?? "Loading…";
	let t3;
	if ($[7] !== activeWorkspaceId || $[8] !== rolesByWorkspaceId) {
		t3 = activeWorkspaceId ? rolesByWorkspaceId.get(activeWorkspaceId) === "viewer" : false;
		$[7] = activeWorkspaceId;
		$[8] = rolesByWorkspaceId;
		$[9] = t3;
	} else t3 = $[9];
	const activeIsViewer = t3;
	let t4;
	if ($[10] !== activeWorkspaceId || $[11] !== repo || $[12] !== setHash) {
		t4 = (workspace) => {
			if (workspace.id === activeWorkspaceId) return;
			repo.setActiveWorkspaceId(workspace.id);
			setHash(buildAppHash(workspace.id));
		};
		$[10] = activeWorkspaceId;
		$[11] = repo;
		$[12] = setHash;
		$[13] = t4;
	} else t4 = $[13];
	const navigateToWorkspace = t4;
	let t5;
	if ($[14] !== setHash) {
		t5 = () => {
			forgetRememberedWorkspace();
			setHash("");
		};
		$[14] = setHash;
		$[15] = t5;
	} else t5 = $[15];
	const handleDeleted = t5;
	let t6;
	if ($[16] !== triggerClassName) {
		t6 = cn("flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors max-w-[14rem]", triggerClassName);
		$[16] = triggerClassName;
		$[17] = t6;
	} else t6 = $[17];
	let t7;
	if ($[18] !== displayName) {
		t7 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: displayName
		});
		$[18] = displayName;
		$[19] = t7;
	} else t7 = $[19];
	let t8;
	if ($[20] !== activeIsViewer) {
		t8 = activeIsViewer && /* @__PURE__ */ jsx(Eye, {
			className: "h-3.5 w-3.5 shrink-0 opacity-70",
			"aria-label": "Read-only"
		});
		$[20] = activeIsViewer;
		$[21] = t8;
	} else t8 = $[21];
	let t9;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsx(ChevronDown, { className: "h-3 w-3 shrink-0 opacity-60" });
		$[22] = t9;
	} else t9 = $[22];
	let t10;
	if ($[23] !== t6 || $[24] !== t7 || $[25] !== t8) {
		t10 = /* @__PURE__ */ jsx(DropdownMenuTrigger, {
			asChild: true,
			children: /* @__PURE__ */ jsxs("button", {
				className: t6,
				"aria-label": "Switch workspace",
				children: [
					t7,
					t8,
					t9
				]
			})
		});
		$[23] = t6;
		$[24] = t7;
		$[25] = t8;
		$[26] = t10;
	} else t10 = $[26];
	let t11;
	if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = /* @__PURE__ */ jsx(DropdownMenuLabel, {
			className: "text-xs uppercase tracking-wide text-muted-foreground",
			children: "Workspaces"
		});
		$[27] = t11;
	} else t11 = $[27];
	let t12;
	if ($[28] !== activeWorkspaceId || $[29] !== navigateToWorkspace || $[30] !== rolesByWorkspaceId || $[31] !== workspaces) {
		let t13;
		if ($[33] !== activeWorkspaceId || $[34] !== navigateToWorkspace || $[35] !== rolesByWorkspaceId) {
			t13 = (w_0) => {
				const isViewer = rolesByWorkspaceId.get(w_0.id) === "viewer";
				return /* @__PURE__ */ jsxs(DropdownMenuItem, {
					onSelect: () => navigateToWorkspace(w_0),
					className: w_0.id === activeWorkspaceId ? "font-medium" : void 0,
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "truncate",
							children: w_0.name
						}),
						isViewer && /* @__PURE__ */ jsx(Eye, {
							className: "h-3.5 w-3.5 shrink-0 opacity-60",
							"aria-label": "Read-only"
						}),
						w_0.id === activeWorkspaceId && /* @__PURE__ */ jsx("span", {
							className: "ml-auto text-xs text-muted-foreground",
							children: "current"
						})
					]
				}, w_0.id);
			};
			$[33] = activeWorkspaceId;
			$[34] = navigateToWorkspace;
			$[35] = rolesByWorkspaceId;
			$[36] = t13;
		} else t13 = $[36];
		t12 = workspaces.map(t13);
		$[28] = activeWorkspaceId;
		$[29] = navigateToWorkspace;
		$[30] = rolesByWorkspaceId;
		$[31] = workspaces;
		$[32] = t12;
	} else t12 = $[32];
	let t13;
	if ($[37] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = /* @__PURE__ */ jsx(DropdownMenuSeparator, {});
		$[37] = t13;
	} else t13 = $[37];
	let t14;
	if ($[38] !== localOnly) {
		t14 = !localOnly && /* @__PURE__ */ jsxs(DropdownMenuItem, {
			onSelect: () => {
				setTimeout(() => setCreateOpen(true), 0);
			},
			children: [/* @__PURE__ */ jsx(Plus, { className: "h-3.5 w-3.5" }), /* @__PURE__ */ jsx("span", { children: "New workspace" })]
		});
		$[38] = localOnly;
		$[39] = t14;
	} else t14 = $[39];
	let t15;
	if ($[40] !== activeWorkspace || $[41] !== localOnly) {
		t15 = activeWorkspace && !localOnly && /* @__PURE__ */ jsxs(DropdownMenuItem, {
			onSelect: () => {
				setTimeout(() => setSettingsOpen(true), 0);
			},
			children: [/* @__PURE__ */ jsx(Settings, { className: "h-3.5 w-3.5" }), /* @__PURE__ */ jsx("span", { children: "Workspace settings" })]
		});
		$[40] = activeWorkspace;
		$[41] = localOnly;
		$[42] = t15;
	} else t15 = $[42];
	let t16;
	if ($[43] !== t12 || $[44] !== t14 || $[45] !== t15) {
		t16 = /* @__PURE__ */ jsxs(DropdownMenuContent, {
			align: "start",
			className: "w-56",
			children: [
				t11,
				t12,
				t13,
				t14,
				t15
			]
		});
		$[43] = t12;
		$[44] = t14;
		$[45] = t15;
		$[46] = t16;
	} else t16 = $[46];
	let t17;
	if ($[47] !== t10 || $[48] !== t16) {
		t17 = /* @__PURE__ */ jsxs(DropdownMenu, { children: [t10, t16] });
		$[47] = t10;
		$[48] = t16;
		$[49] = t17;
	} else t17 = $[49];
	let t18;
	if ($[50] !== navigateToWorkspace) {
		t18 = (w_1) => navigateToWorkspace(w_1);
		$[50] = navigateToWorkspace;
		$[51] = t18;
	} else t18 = $[51];
	let t19;
	if ($[52] !== createOpen || $[53] !== t18) {
		t19 = /* @__PURE__ */ jsx(CreateWorkspaceDialog, {
			open: createOpen,
			onOpenChange: setCreateOpen,
			onCreated: t18
		});
		$[52] = createOpen;
		$[53] = t18;
		$[54] = t19;
	} else t19 = $[54];
	let t20;
	if ($[55] !== activeWorkspace || $[56] !== handleDeleted || $[57] !== settingsOpen) {
		t20 = activeWorkspace && /* @__PURE__ */ jsx(WorkspaceSettingsDialog, {
			workspace: activeWorkspace,
			open: settingsOpen,
			onOpenChange: setSettingsOpen,
			onDeleted: handleDeleted
		});
		$[55] = activeWorkspace;
		$[56] = handleDeleted;
		$[57] = settingsOpen;
		$[58] = t20;
	} else t20 = $[58];
	let t21;
	if ($[59] !== t17 || $[60] !== t19 || $[61] !== t20) {
		t21 = /* @__PURE__ */ jsxs(Fragment$1, { children: [
			t17,
			t19,
			t20
		] });
		$[59] = t17;
		$[60] = t19;
		$[61] = t20;
		$[62] = t21;
	} else t21 = $[62];
	return t21;
}
//#endregion
export { WorkspaceSwitcher };

//# sourceMappingURL=WorkspaceSwitcher.js.map