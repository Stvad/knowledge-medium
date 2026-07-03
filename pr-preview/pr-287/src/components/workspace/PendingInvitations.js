import { Button } from "../ui/button.js";
import { useHash } from "../../../node_modules/react-use/esm/useHash.js";
import { useIsLocalOnly } from "../Login.js";
import { Mail } from "../../../node_modules/lucide-react/dist/esm/icons/mail.js";
import { buildAppHash } from "../../utils/routing.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { acceptInvitation, declineInvitation } from "../../data/workspaces.js";
import { usePendingInvitations } from "../../hooks/usePendingInvitations.js";
import { useMemo, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/workspace/PendingInvitations.tsx
function PendingInvitations() {
	const $ = c(1);
	if (useIsLocalOnly()) return null;
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx(PendingInvitationsInner, {});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
function PendingInvitationsInner() {
	const { invitations, refresh } = usePendingInvitations();
	const [, setHash] = useHash();
	const [busyId, setBusyId] = useState(null);
	const [error, setError] = useState(null);
	const count = invitations.length;
	const label = useMemo(() => count === 0 ? "No invitations" : `${count} invitation${count > 1 ? "s" : ""}`, [count]);
	if (count === 0) return null;
	const accept = async (id, workspaceId) => {
		setBusyId(id);
		setError(null);
		try {
			await acceptInvitation(id);
			await refresh();
			setHash(buildAppHash(workspaceId));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to accept invitation");
			setBusyId(null);
		}
	};
	const decline = async (id_0) => {
		setBusyId(id_0);
		setError(null);
		try {
			await declineInvitation(id_0);
			await refresh();
		} catch (err_0) {
			setError(err_0 instanceof Error ? err_0.message : "Failed to decline invitation");
		} finally {
			setBusyId(null);
		}
	};
	return /* @__PURE__ */ jsxs(DropdownMenu, { children: [/* @__PURE__ */ jsx(DropdownMenuTrigger, {
		asChild: true,
		children: /* @__PURE__ */ jsxs("button", {
			className: "relative flex h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-auto sm:w-auto sm:px-2 sm:py-1",
			"aria-label": label,
			children: [/* @__PURE__ */ jsx(Mail, { className: "h-4 w-4" }), /* @__PURE__ */ jsx("span", {
				className: "absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center px-1",
				children: count
			})]
		})
	}), /* @__PURE__ */ jsxs(DropdownMenuContent, {
		align: "end",
		className: "w-72",
		children: [
			/* @__PURE__ */ jsx(DropdownMenuLabel, { children: "Pending invitations" }),
			/* @__PURE__ */ jsx(DropdownMenuSeparator, {}),
			/* @__PURE__ */ jsx("ul", {
				className: "max-h-80 overflow-y-auto",
				children: invitations.map((inv) => /* @__PURE__ */ jsxs("li", {
					className: "px-2 py-2 text-sm space-y-2",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "space-y-0.5",
						children: [/* @__PURE__ */ jsx("div", {
							className: "font-medium truncate",
							children: inv.workspaceName ?? inv.workspaceId
						}), /* @__PURE__ */ jsxs("div", {
							className: "text-xs text-muted-foreground",
							children: ["Joining as ", /* @__PURE__ */ jsx("span", {
								className: "font-medium",
								children: inv.role
							})]
						})]
					}), /* @__PURE__ */ jsxs("div", {
						className: "flex gap-2",
						children: [/* @__PURE__ */ jsx(Button, {
							size: "sm",
							className: "h-7 text-xs",
							disabled: busyId === inv.id,
							onClick: () => void accept(inv.id, inv.workspaceId),
							children: "Accept"
						}), /* @__PURE__ */ jsx(Button, {
							size: "sm",
							variant: "ghost",
							className: "h-7 text-xs",
							disabled: busyId === inv.id,
							onClick: () => void decline(inv.id),
							children: "Decline"
						})]
					})]
				}, inv.id))
			}),
			error && /* @__PURE__ */ jsx("p", {
				className: "px-2 py-1 text-xs text-destructive",
				children: error
			})
		]
	})] });
}
//#endregion
export { PendingInvitations };

//# sourceMappingURL=PendingInvitations.js.map