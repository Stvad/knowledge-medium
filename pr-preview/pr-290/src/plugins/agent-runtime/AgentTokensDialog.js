import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { useRepo } from "../../context/repo.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { agentTokenStore, notifyAgentTokensChanged } from "./tokens.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/agent-runtime/AgentTokensDialog.tsx
function AgentTokensDialog(t0) {
	const $ = c(20);
	const { mode: t1, cancel } = t0;
	const mode = t1 === void 0 ? "manage" : t1;
	const repo = useRepo();
	const userId = repo.user.id;
	const workspaceId = repo.activeWorkspaceId;
	const noWorkspace = !userId || !workspaceId;
	const pairing = mode === "pair-cli";
	let t2;
	if ($[0] !== cancel) {
		t2 = (next) => {
			if (!next) cancel();
		};
		$[0] = cancel;
		$[1] = t2;
	} else t2 = $[1];
	const t3 = pairing ? "Pair agent CLI" : "Agent runtime tokens";
	let t4;
	if ($[2] !== t3) {
		t4 = /* @__PURE__ */ jsx(DialogTitle, { children: t3 });
		$[2] = t3;
		$[3] = t4;
	} else t4 = $[3];
	const t5 = pairing ? "Generate a token for this workspace, copy it, then paste it into the waiting terminal prompt." : "Tokens authorize a local agent process to drive this workspace as you. Stored on this device only; each token is shown once at mint.";
	let t6;
	if ($[4] !== t5) {
		t6 = /* @__PURE__ */ jsx(DialogDescription, { children: t5 });
		$[4] = t5;
		$[5] = t6;
	} else t6 = $[5];
	let t7;
	if ($[6] !== t4 || $[7] !== t6) {
		t7 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t4, t6] });
		$[6] = t4;
		$[7] = t6;
		$[8] = t7;
	} else t7 = $[8];
	let t8;
	if ($[9] !== noWorkspace || $[10] !== pairing || $[11] !== userId || $[12] !== workspaceId) {
		t8 = noWorkspace ? /* @__PURE__ */ jsx("p", {
			className: "text-sm text-destructive",
			children: "Open a workspace before minting agent tokens."
		}) : /* @__PURE__ */ jsx(AgentTokensDialogBody, {
			userId,
			workspaceId,
			pairing
		});
		$[9] = noWorkspace;
		$[10] = pairing;
		$[11] = userId;
		$[12] = workspaceId;
		$[13] = t8;
	} else t8 = $[13];
	let t9;
	if ($[14] !== t7 || $[15] !== t8) {
		t9 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto",
			children: [t7, t8]
		});
		$[14] = t7;
		$[15] = t8;
		$[16] = t9;
	} else t9 = $[16];
	let t10;
	if ($[17] !== t2 || $[18] !== t9) {
		t10 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t2,
			children: t9
		});
		$[17] = t2;
		$[18] = t9;
		$[19] = t10;
	} else t10 = $[19];
	return t10;
}
function AgentTokensDialogBody(t0) {
	const $ = c(51);
	const { userId, workspaceId, pairing } = t0;
	let t1;
	if ($[0] !== userId || $[1] !== workspaceId) {
		t1 = () => agentTokenStore.list(userId, workspaceId);
		$[0] = userId;
		$[1] = workspaceId;
		$[2] = t1;
	} else t1 = $[2];
	const [tokens, setTokens] = useState(t1);
	const [label, setLabel] = useState(pairing ? "agent-cli" : "");
	const [readOnly, setReadOnly] = useState(false);
	const [justMinted, setJustMinted] = useState(null);
	const [copyState, setCopyState] = useState("idle");
	let t2;
	if ($[3] !== userId || $[4] !== workspaceId) {
		t2 = () => setTokens(agentTokenStore.list(userId, workspaceId));
		$[3] = userId;
		$[4] = workspaceId;
		$[5] = t2;
	} else t2 = $[5];
	const refresh = t2;
	let t3;
	if ($[6] !== label || $[7] !== readOnly || $[8] !== refresh || $[9] !== userId || $[10] !== workspaceId) {
		t3 = () => {
			const token = agentTokenStore.create(userId, workspaceId, label, readOnly ? "read-only" : "read-write");
			notifyAgentTokensChanged();
			setJustMinted(token);
			setCopyState("idle");
			setLabel("");
			refresh();
		};
		$[6] = label;
		$[7] = readOnly;
		$[8] = refresh;
		$[9] = userId;
		$[10] = workspaceId;
		$[11] = t3;
	} else t3 = $[11];
	const mint = t3;
	let t4;
	if ($[12] !== justMinted?.token || $[13] !== refresh || $[14] !== userId || $[15] !== workspaceId) {
		t4 = (token_0) => {
			agentTokenStore.revoke(userId, workspaceId, token_0);
			notifyAgentTokensChanged();
			if (justMinted?.token === token_0) setJustMinted(null);
			refresh();
		};
		$[12] = justMinted?.token;
		$[13] = refresh;
		$[14] = userId;
		$[15] = workspaceId;
		$[16] = t4;
	} else t4 = $[16];
	const revoke = t4;
	let t5;
	if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = async (text) => {
			try {
				await navigator.clipboard.writeText(text);
				setCopyState("copied");
				window.setTimeout(() => setCopyState("idle"), 1500);
			} catch (t6) {
				console.error("Clipboard write failed", t6);
			}
		};
		$[17] = t5;
	} else t5 = $[17];
	const copy = t5;
	let t6;
	if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(Label, {
			htmlFor: "agent-token-label",
			children: "New token label"
		});
		$[18] = t6;
	} else t6 = $[18];
	let t7;
	if ($[19] !== pairing) {
		t7 = pairing && /* @__PURE__ */ jsx("p", {
			className: "text-xs text-muted-foreground",
			children: "Use a label that identifies this terminal session."
		});
		$[19] = pairing;
		$[20] = t7;
	} else t7 = $[20];
	let t8;
	if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = (e) => setLabel(e.target.value);
		$[21] = t8;
	} else t8 = $[21];
	let t9;
	if ($[22] !== mint) {
		t9 = (e_0) => {
			if (e_0.key === "Enter") mint();
		};
		$[22] = mint;
		$[23] = t9;
	} else t9 = $[23];
	let t10;
	if ($[24] !== label || $[25] !== t9) {
		t10 = /* @__PURE__ */ jsx(Input, {
			id: "agent-token-label",
			className: "min-w-0 flex-1",
			placeholder: "e.g. claude-cli",
			value: label,
			onChange: t8,
			onKeyDown: t9
		});
		$[24] = label;
		$[25] = t9;
		$[26] = t10;
	} else t10 = $[26];
	let t11;
	if ($[27] !== mint) {
		t11 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			className: "shrink-0",
			onClick: mint,
			children: "Generate"
		});
		$[27] = mint;
		$[28] = t11;
	} else t11 = $[28];
	let t12;
	if ($[29] !== t10 || $[30] !== t11) {
		t12 = /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 gap-2",
			children: [t10, t11]
		});
		$[29] = t10;
		$[30] = t11;
		$[31] = t12;
	} else t12 = $[31];
	let t13;
	if ($[32] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = (e_1) => setReadOnly(e_1.target.checked);
		$[32] = t13;
	} else t13 = $[32];
	let t14;
	if ($[33] !== readOnly) {
		t14 = /* @__PURE__ */ jsxs("label", {
			className: "flex items-center gap-2 text-sm",
			children: [/* @__PURE__ */ jsx("input", {
				type: "checkbox",
				className: "size-4",
				checked: readOnly,
				onChange: t13
			}), "Read-only"]
		});
		$[33] = readOnly;
		$[34] = t14;
	} else t14 = $[34];
	let t15;
	if ($[35] !== t12 || $[36] !== t14 || $[37] !== t7) {
		t15 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [
				t6,
				t7,
				t12,
				t14
			]
		});
		$[35] = t12;
		$[36] = t14;
		$[37] = t7;
		$[38] = t15;
	} else t15 = $[38];
	let t16;
	if ($[39] !== copyState || $[40] !== justMinted || $[41] !== pairing) {
		t16 = justMinted && /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 rounded-md border bg-muted/40 p-3 space-y-2",
			children: [
				/* @__PURE__ */ jsx("p", {
					className: "text-xs font-medium text-muted-foreground",
					children: "Copy now. This is the only time the secret is shown."
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 items-center gap-2",
					children: [/* @__PURE__ */ jsx("code", {
						className: "min-w-0 flex-1 truncate text-xs font-mono",
						children: justMinted.token
					}), /* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "secondary",
						size: "sm",
						className: "shrink-0",
						onClick: () => copy(justMinted.token),
						children: copyState === "copied" ? "Copied" : "Copy"
					})]
				}),
				/* @__PURE__ */ jsx("p", {
					className: "min-w-0 text-xs text-muted-foreground",
					children: pairing ? "Paste this token into the waiting terminal prompt to finish pairing." : /* @__PURE__ */ jsxs(Fragment$1, { children: [
						"Run",
						" ",
						/* @__PURE__ */ jsxs("code", {
							className: "break-all whitespace-normal",
							children: ["yarn agent connect ", justMinted.token]
						}),
						" ",
						"to register it with the CLI."
					] })
				})
			]
		});
		$[39] = copyState;
		$[40] = justMinted;
		$[41] = pairing;
		$[42] = t16;
	} else t16 = $[42];
	let t17;
	if ($[43] === Symbol.for("react.memo_cache_sentinel")) {
		t17 = /* @__PURE__ */ jsx(Label, { children: "Existing tokens" });
		$[43] = t17;
	} else t17 = $[43];
	let t18;
	if ($[44] !== revoke || $[45] !== tokens) {
		t18 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [t17, tokens.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: "No tokens yet."
			}) : /* @__PURE__ */ jsx("ul", {
				className: "space-y-1.5",
				children: tokens.map((t) => /* @__PURE__ */ jsxs("li", {
					className: "flex items-center justify-between rounded border p-2 text-sm",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "min-w-0",
						children: [/* @__PURE__ */ jsx("div", {
							className: "font-medium truncate",
							children: t.label
						}), /* @__PURE__ */ jsxs("div", {
							className: "text-xs text-muted-foreground",
							children: [
								(t.scope ?? "read-write") === "read-only" ? "read-only" : "read/write",
								" · ",
								"created ",
								new Date(t.createdAt).toLocaleString(),
								t.lastSeenAt ? ` · last seen ${new Date(t.lastSeenAt).toLocaleString()}` : ""
							]
						})]
					}), /* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "destructive",
						size: "sm",
						onClick: () => revoke(t.token),
						children: "Revoke"
					})]
				}, t.token))
			})]
		});
		$[44] = revoke;
		$[45] = tokens;
		$[46] = t18;
	} else t18 = $[46];
	let t19;
	if ($[47] !== t15 || $[48] !== t16 || $[49] !== t18) {
		t19 = /* @__PURE__ */ jsxs(Fragment$1, { children: [
			t15,
			t16,
			t18
		] });
		$[47] = t15;
		$[48] = t16;
		$[49] = t18;
		$[50] = t19;
	} else t19 = $[50];
	return t19;
}
//#endregion
export { AgentTokensDialog };

//# sourceMappingURL=AgentTokensDialog.js.map