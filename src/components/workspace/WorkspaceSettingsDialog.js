import { cn } from "../../lib/utils.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useRepo } from "../../context/repo.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Label } from "../ui/label.js";
import { deleteWorkspace, inviteMemberByEmail, listWorkspaceMembersWithEmails, removeWorkspaceMember, renameWorkspace, updateWorkspaceMemberRole } from "../../data/workspaces.js";
import { useCallback, useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/workspace/WorkspaceSettingsDialog.tsx
var INVITE_ROLES = [{
	value: "editor",
	label: "Editor",
	hint: "Can read and edit the workspace."
}, {
	value: "viewer",
	label: "Viewer",
	hint: "Read-only access; cannot modify the workspace."
}];
var roleSelectClassName = "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
function WorkspaceSettingsDialog(t0) {
	const $ = c(33);
	const { workspace, open, onOpenChange, onDeleted } = t0;
	const repo = useRepo();
	const isOwner = workspace.ownerUserId === repo.user.id;
	const isViewer = repo.isReadOnly;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx(DialogTitle, { children: "Workspace settings" });
		$[0] = t1;
	} else t1 = $[0];
	let t2;
	if ($[1] !== workspace.name) {
		t2 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t1, /* @__PURE__ */ jsx(DialogDescription, { children: workspace.name })] });
		$[1] = workspace.name;
		$[2] = t2;
	} else t2 = $[2];
	const t3 = !isOwner;
	let t4;
	if ($[3] !== t3 || $[4] !== workspace) {
		t4 = /* @__PURE__ */ jsx(RenameSection, {
			workspace,
			disabled: t3
		}, workspace.id);
		$[3] = t3;
		$[4] = workspace;
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] !== isOwner || $[7] !== workspace) {
		t5 = /* @__PURE__ */ jsx(MembersSection, {
			workspace,
			canManage: isOwner
		}, workspace.id);
		$[6] = isOwner;
		$[7] = workspace;
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] !== isOwner || $[10] !== onDeleted || $[11] !== onOpenChange || $[12] !== workspace) {
		t6 = isOwner && /* @__PURE__ */ jsx(DangerSection, {
			workspace,
			onDeleted: () => {
				onOpenChange(false);
				onDeleted();
			}
		});
		$[9] = isOwner;
		$[10] = onDeleted;
		$[11] = onOpenChange;
		$[12] = workspace;
		$[13] = t6;
	} else t6 = $[13];
	let t7;
	if ($[14] !== isOwner || $[15] !== isViewer) {
		t7 = !isOwner && isViewer && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-muted-foreground",
			children: "You have read-only access to this workspace. Edits made locally won't be saved."
		});
		$[14] = isOwner;
		$[15] = isViewer;
		$[16] = t7;
	} else t7 = $[16];
	let t8;
	if ($[17] !== isOwner || $[18] !== isViewer) {
		t8 = !isOwner && !isViewer && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-muted-foreground",
			children: "Only the workspace owner can rename, invite members, or delete this workspace."
		});
		$[17] = isOwner;
		$[18] = isViewer;
		$[19] = t8;
	} else t8 = $[19];
	let t9;
	if ($[20] !== t4 || $[21] !== t5 || $[22] !== t6 || $[23] !== t7 || $[24] !== t8) {
		t9 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-6",
			children: [
				t4,
				t5,
				t6,
				t7,
				t8
			]
		});
		$[20] = t4;
		$[21] = t5;
		$[22] = t6;
		$[23] = t7;
		$[24] = t8;
		$[25] = t9;
	} else t9 = $[25];
	let t10;
	if ($[26] !== t2 || $[27] !== t9) {
		t10 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-xl",
			children: [t2, t9]
		});
		$[26] = t2;
		$[27] = t9;
		$[28] = t10;
	} else t10 = $[28];
	let t11;
	if ($[29] !== onOpenChange || $[30] !== open || $[31] !== t10) {
		t11 = /* @__PURE__ */ jsx(Dialog, {
			open,
			onOpenChange,
			children: t10
		});
		$[29] = onOpenChange;
		$[30] = open;
		$[31] = t10;
		$[32] = t11;
	} else t11 = $[32];
	return t11;
}
function RenameSection({ workspace, disabled }) {
	const [name, setName] = useState(workspace.name);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState(null);
	const [info, setInfo] = useState(null);
	const submit = async (event) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || trimmed === workspace.name) return;
		setSubmitting(true);
		setError(null);
		setInfo(null);
		try {
			await renameWorkspace(workspace.id, trimmed);
			setInfo("Renamed.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Rename failed");
		} finally {
			setSubmitting(false);
		}
	};
	return /* @__PURE__ */ jsxs("form", {
		onSubmit: submit,
		className: "space-y-2",
		children: [
			/* @__PURE__ */ jsx(Label, {
				htmlFor: "ws-rename",
				children: "Name"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex gap-2",
				children: [/* @__PURE__ */ jsx(Input, {
					id: "ws-rename",
					value: name,
					onChange: (e) => setName(e.target.value),
					disabled: disabled || submitting
				}), /* @__PURE__ */ jsx(Button, {
					type: "submit",
					disabled: disabled || submitting || !name.trim() || name.trim() === workspace.name,
					children: submitting ? "Saving…" : "Save"
				})]
			}),
			error && /* @__PURE__ */ jsx("p", {
				className: "text-sm text-destructive",
				children: error
			}),
			info && /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: info
			})
		]
	});
}
function MembersSection({ workspace, canManage }) {
	const repo = useRepo();
	const [members, setMembers] = useState([]);
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState("editor");
	const [submitting, setSubmitting] = useState(false);
	const [pendingRoleUserId, setPendingRoleUserId] = useState(null);
	const [error, setError] = useState(null);
	const [info, setInfo] = useState(null);
	const refreshMembers = useCallback(async () => {
		try {
			setMembers(await listWorkspaceMembersWithEmails(workspace.id));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load members");
		}
	}, [workspace.id]);
	useEffect(() => {
		refreshMembers();
	}, [refreshMembers]);
	const invite = async (event) => {
		event.preventDefault();
		const trimmed = email.trim();
		if (!trimmed) return;
		setSubmitting(true);
		setError(null);
		setInfo(null);
		try {
			await inviteMemberByEmail(workspace.id, trimmed, inviteRole);
			setInfo(`Invitation sent to ${trimmed} as ${inviteRole}. They'll see it next time they sign in.`);
			setEmail("");
		} catch (err_0) {
			setError(err_0 instanceof Error ? err_0.message : "Invite failed");
		} finally {
			setSubmitting(false);
		}
	};
	const remove = async (userId) => {
		setError(null);
		setInfo(null);
		try {
			await removeWorkspaceMember(workspace.id, userId);
			await refreshMembers();
		} catch (err_1) {
			setError(err_1 instanceof Error ? err_1.message : "Remove failed");
		}
	};
	const changeRole = async (userId_0, role) => {
		setError(null);
		setInfo(null);
		setPendingRoleUserId(userId_0);
		try {
			await updateWorkspaceMemberRole(workspace.id, userId_0, role);
			await refreshMembers();
		} catch (err_2) {
			setError(err_2 instanceof Error ? err_2.message : "Role change failed");
		} finally {
			setPendingRoleUserId(null);
		}
	};
	const inviteHint = INVITE_ROLES.find((r) => r.value === inviteRole)?.hint;
	return /* @__PURE__ */ jsxs("div", {
		className: "space-y-3",
		children: [
			/* @__PURE__ */ jsx(Label, { children: "Members" }),
			/* @__PURE__ */ jsxs("ul", {
				className: "space-y-1 rounded-md border divide-y",
				children: [members.length === 0 && /* @__PURE__ */ jsx("li", {
					className: "px-3 py-2 text-sm text-muted-foreground",
					children: "Just you for now."
				}), members.map((m) => {
					const canEditThisMember = canManage && m.role !== "owner" && m.userId !== repo.user.id;
					return /* @__PURE__ */ jsxs("li", {
						className: "flex items-center gap-3 px-3 py-2 text-sm",
						children: [
							/* @__PURE__ */ jsx("span", {
								className: "truncate flex-1",
								children: m.email || /* @__PURE__ */ jsx("span", {
									className: "font-mono text-xs text-muted-foreground",
									children: m.userId
								})
							}),
							canEditThisMember ? /* @__PURE__ */ jsx("select", {
								className: cn(roleSelectClassName, "h-7 py-0 text-xs uppercase tracking-wide"),
								value: m.role,
								disabled: pendingRoleUserId === m.userId,
								onChange: (e) => void changeRole(m.userId, e.target.value),
								"aria-label": `Change role for ${m.email || m.userId}`,
								children: INVITE_ROLES.map((r_0) => /* @__PURE__ */ jsx("option", {
									value: r_0.value,
									children: r_0.label
								}, r_0.value))
							}) : /* @__PURE__ */ jsx("span", {
								className: "text-xs uppercase tracking-wide rounded bg-muted px-2 py-0.5",
								children: m.role
							}),
							canEditThisMember && /* @__PURE__ */ jsx("button", {
								type: "button",
								className: "text-xs text-muted-foreground hover:text-destructive transition-colors",
								onClick: () => void remove(m.userId),
								children: "Remove"
							})
						]
					}, m.id);
				})]
			}),
			canManage && workspace.encryptionMode === "e2ee" && /* @__PURE__ */ jsxs("p", {
				className: "rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground",
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "font-medium text-foreground",
						children: "End-to-end encrypted."
					}),
					" ",
					"After an invitee accepts, send them this workspace’s key yourself over a channel you trust (Signal, a password manager, in person). The app never transmits the key — without it they’ll see a locked, empty workspace."
				]
			}),
			canManage && /* @__PURE__ */ jsxs("form", {
				onSubmit: invite,
				className: "space-y-2",
				children: [
					/* @__PURE__ */ jsx(Label, {
						htmlFor: "ws-invite",
						children: "Invite by email"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "flex gap-2",
						children: [
							/* @__PURE__ */ jsx(Input, {
								id: "ws-invite",
								type: "email",
								placeholder: "someone@example.com",
								value: email,
								onChange: (e_0) => setEmail(e_0.target.value),
								disabled: submitting,
								className: "flex-1"
							}),
							/* @__PURE__ */ jsx("select", {
								className: roleSelectClassName,
								value: inviteRole,
								onChange: (e_1) => setInviteRole(e_1.target.value),
								disabled: submitting,
								"aria-label": "Invite role",
								children: INVITE_ROLES.map((r_1) => /* @__PURE__ */ jsx("option", {
									value: r_1.value,
									children: r_1.label
								}, r_1.value))
							}),
							/* @__PURE__ */ jsx(Button, {
								type: "submit",
								disabled: submitting || !email.trim(),
								children: submitting ? "Sending…" : "Invite"
							})
						]
					}),
					inviteHint && /* @__PURE__ */ jsx("p", {
						className: "text-xs text-muted-foreground",
						children: inviteHint
					})
				]
			}),
			error && /* @__PURE__ */ jsx("p", {
				className: "text-sm text-destructive",
				children: error
			}),
			info && /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: info
			})
		]
	});
}
function DangerSection(t0) {
	const $ = c(23);
	const { workspace, onDeleted } = t0;
	const [confirmName, setConfirmName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState(null);
	const canDelete = confirmName === workspace.name;
	let t1;
	if ($[0] !== canDelete || $[1] !== onDeleted || $[2] !== workspace.id) {
		t1 = async () => {
			if (!canDelete) return;
			setSubmitting(true);
			setError(null);
			try {
				await deleteWorkspace(workspace.id);
				onDeleted();
			} catch (t2) {
				const err = t2;
				setError(err instanceof Error ? err.message : "Delete failed");
				setSubmitting(false);
			}
		};
		$[0] = canDelete;
		$[1] = onDeleted;
		$[2] = workspace.id;
		$[3] = t1;
	} else t1 = $[3];
	const submit = t1;
	let t2;
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(Label, {
			className: "text-destructive",
			children: "Delete workspace"
		});
		t3 = /* @__PURE__ */ jsx("p", {
			className: "text-sm text-muted-foreground",
			children: "This permanently deletes the workspace and all its blocks. To confirm, type the workspace name below."
		});
		$[4] = t2;
		$[5] = t3;
	} else {
		t2 = $[4];
		t3 = $[5];
	}
	let t4;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = (e) => setConfirmName(e.target.value);
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== confirmName || $[8] !== submitting || $[9] !== workspace.name) {
		t5 = /* @__PURE__ */ jsx(Input, {
			placeholder: workspace.name,
			value: confirmName,
			onChange: t4,
			disabled: submitting
		});
		$[7] = confirmName;
		$[8] = submitting;
		$[9] = workspace.name;
		$[10] = t5;
	} else t5 = $[10];
	const t6 = !canDelete || submitting;
	let t7;
	if ($[11] !== submit) {
		t7 = () => void submit();
		$[11] = submit;
		$[12] = t7;
	} else t7 = $[12];
	const t8 = submitting ? "Deleting…" : "Delete workspace";
	let t9;
	if ($[13] !== t6 || $[14] !== t7 || $[15] !== t8) {
		t9 = /* @__PURE__ */ jsx(Button, {
			variant: "outline",
			className: "border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive",
			disabled: t6,
			onClick: t7,
			children: t8
		});
		$[13] = t6;
		$[14] = t7;
		$[15] = t8;
		$[16] = t9;
	} else t9 = $[16];
	let t10;
	if ($[17] !== error) {
		t10 = error && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-destructive",
			children: error
		});
		$[17] = error;
		$[18] = t10;
	} else t10 = $[18];
	let t11;
	if ($[19] !== t10 || $[20] !== t5 || $[21] !== t9) {
		t11 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2 rounded-md border border-destructive/40 p-3",
			children: [
				t2,
				t3,
				t5,
				t9,
				t10
			]
		});
		$[19] = t10;
		$[20] = t5;
		$[21] = t9;
		$[22] = t11;
	} else t11 = $[22];
	return t11;
}
//#endregion
export { WorkspaceSettingsDialog };

//# sourceMappingURL=WorkspaceSettingsDialog.js.map