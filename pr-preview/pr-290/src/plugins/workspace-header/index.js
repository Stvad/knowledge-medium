import { systemToggle } from "../../facets/togglable.js";
import { headerItemsFacet } from "../../extensions/core.js";
import { PendingInvitations } from "../../components/workspace/PendingInvitations.js";
import { WorkspaceSwitcher } from "../../components/workspace/WorkspaceSwitcher.js";
import { leftSidebarSectionsFacet } from "../left-sidebar/facet.js";
import "../left-sidebar/index.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/workspace-header/index.tsx
var WorkspaceSwitcherSidebarSection = () => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("section", { children: /* @__PURE__ */ jsx(WorkspaceSwitcher, { triggerClassName: "h-11 w-full max-w-none justify-between rounded-lg border border-border px-3 text-base" }) });
		$[0] = t0;
	} else t0 = $[0];
	return t0;
};
var workspaceSwitcherSidebarSection = {
	id: "workspace-header.switcher",
	component: WorkspaceSwitcherSidebarSection
};
var pendingInvitationsHeaderItem = {
	id: "workspace-header.pending-invitations",
	region: "end",
	component: PendingInvitations
};
var workspaceHeaderPlugin = systemToggle({
	id: "system:workspace-header",
	name: "Workspace header",
	description: "Top-of-app header with the workspace switcher.",
	essential: true
}).of([leftSidebarSectionsFacet.of(workspaceSwitcherSidebarSection, {
	source: "workspace-header",
	precedence: -20
}), headerItemsFacet.of(pendingInvitationsHeaderItem, {
	source: "workspace-header",
	precedence: 30
})]);
//#endregion
export { WorkspaceSwitcherSidebarSection, pendingInvitationsHeaderItem, workspaceHeaderPlugin, workspaceSwitcherSidebarSection };

//# sourceMappingURL=index.js.map