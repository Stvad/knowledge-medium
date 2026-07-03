import { useSignOut, useUser } from "../../components/Login.js";
import { userPageBlockId } from "../../data/stateBlocks.js";
import { LogOut } from "../../../node_modules/lucide-react/dist/esm/icons/log-out.js";
import { buildAppHash } from "../../utils/routing.js";
import { useActiveWorkspaceId } from "../../hooks/useWorkspaces.js";
import { useOpenBlock } from "../../utils/navigation.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/account-header/AccountHeaderItem.tsx
function AccountHeaderItem() {
	const $ = c(14);
	const user = useUser();
	const signOut = useSignOut();
	const workspaceId = useActiveWorkspaceId();
	const userBlockId = user && workspaceId ? userPageBlockId(workspaceId, user.id) : null;
	const handleUserLinkClick = useOpenBlock({
		blockId: userBlockId ?? "",
		workspaceId: workspaceId ?? void 0
	});
	if (!user || !workspaceId || !userBlockId) return null;
	const displayName = user.name ?? user.id;
	const t0 = "flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground sm:gap-2 sm:text-sm";
	const t1 = buildAppHash(workspaceId, userBlockId);
	let t2;
	if ($[0] !== displayName) {
		t2 = /* @__PURE__ */ jsx("span", {
			className: "min-w-0 truncate",
			children: displayName
		});
		$[0] = displayName;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== handleUserLinkClick || $[3] !== t1 || $[4] !== t2) {
		t3 = /* @__PURE__ */ jsx("a", {
			href: t1,
			onClick: handleUserLinkClick,
			className: "inline-flex h-7 min-w-0 max-w-[7rem] items-center rounded-sm px-0.5 leading-none text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-8 sm:max-w-none",
			children: t2
		});
		$[2] = handleUserLinkClick;
		$[3] = t1;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== signOut) {
		t4 = () => {
			signOut();
		};
		$[6] = signOut;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = /* @__PURE__ */ jsx(LogOut, { className: "h-4 w-4" });
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] !== t4) {
		t6 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-8 sm:w-8",
			onClick: t4,
			title: "Sign out",
			"aria-label": "Sign out",
			children: t5
		});
		$[9] = t4;
		$[10] = t6;
	} else t6 = $[10];
	let t7;
	if ($[11] !== t3 || $[12] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: t0,
			children: [t3, t6]
		});
		$[11] = t3;
		$[12] = t6;
		$[13] = t7;
	} else t7 = $[13];
	return t7;
}
//#endregion
export { AccountHeaderItem };

//# sourceMappingURL=AccountHeaderItem.js.map