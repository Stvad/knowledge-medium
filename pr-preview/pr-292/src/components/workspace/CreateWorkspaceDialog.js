import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { setModePin } from "../../sync/keys/modePin.js";
import { getWorkspaceKeyStore } from "../../sync/keys/keyStore.js";
import { useRepo } from "../../context/repo.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Label } from "../ui/label.js";
import { createWorkspace, primeLocalWorkspaceAndMember } from "../../data/workspaces.js";
import { createEncryptedWorkspace } from "../../sync/keys/flows/createEncryptedWorkspace.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/workspace/CreateWorkspaceDialog.tsx
var CONFIRM_SUFFIX_LEN = 6;
function CreateWorkspaceDialog(t0) {
	const $ = c(26);
	const { open, onOpenChange, onCreated } = t0;
	const repo = useRepo();
	const [name, setName] = useState("");
	const [encrypted, setEncrypted] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState(null);
	const [reveal, setReveal] = useState(null);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = () => {
			setName("");
			setEncrypted(false);
			setError(null);
			setSubmitting(false);
			setReveal(null);
		};
		$[0] = t1;
	} else t1 = $[0];
	const reset = t1;
	let t2;
	if ($[1] !== encrypted || $[2] !== name || $[3] !== onCreated || $[4] !== onOpenChange || $[5] !== repo) {
		t2 = async (event) => {
			event.preventDefault();
			const trimmed = name.trim();
			if (!trimmed) return;
			setError(null);
			setSubmitting(true);
			try {
				if (encrypted) {
					const result = await createEncryptedWorkspace(trimmed, {
						userId: repo.user.id,
						keyStore: getWorkspaceKeyStore(),
						createWorkspace
					});
					setReveal({
						workspace: result.workspace,
						workspaceKey: result.workspaceKey
					});
					setSubmitting(false);
					try {
						await primeLocalWorkspaceAndMember(repo, result.workspace, result.member);
					} catch (t4) {
						console.warn("Failed to prime new encrypted workspace locally (will sync down)", t4);
					}
					return;
				}
				const result_0 = await createWorkspace(trimmed);
				try {
					setModePin(repo.user.id, result_0.workspace.id, "plaintext");
				} catch (t5) {
					console.warn("Failed to pin new workspace plaintext (will quarantine on next load)", t5);
				}
				await primeLocalWorkspaceAndMember(repo, result_0.workspace, result_0.member);
				onCreated(result_0.workspace);
				reset();
				onOpenChange(false);
			} catch (t3) {
				const err = t3;
				setError(err instanceof Error ? err.message : "Failed to create workspace");
				setSubmitting(false);
			}
		};
		$[1] = encrypted;
		$[2] = name;
		$[3] = onCreated;
		$[4] = onOpenChange;
		$[5] = repo;
		$[6] = t2;
	} else t2 = $[6];
	const handleSubmit = t2;
	let t3;
	if ($[7] !== onCreated || $[8] !== onOpenChange || $[9] !== reveal) {
		t3 = () => {
			if (!reveal) return;
			onCreated(reveal.workspace);
			reset();
			onOpenChange(false);
		};
		$[7] = onCreated;
		$[8] = onOpenChange;
		$[9] = reveal;
		$[10] = t3;
	} else t3 = $[10];
	const finishReveal = t3;
	let t4;
	if ($[11] !== onOpenChange || $[12] !== reveal) {
		t4 = (next) => {
			if (!next && reveal) return;
			if (!next) reset();
			onOpenChange(next);
		};
		$[11] = onOpenChange;
		$[12] = reveal;
		$[13] = t4;
	} else t4 = $[13];
	let t5;
	if ($[14] !== encrypted || $[15] !== error || $[16] !== finishReveal || $[17] !== handleSubmit || $[18] !== name || $[19] !== reveal || $[20] !== submitting) {
		t5 = /* @__PURE__ */ jsx(DialogContent, { children: reveal ? /* @__PURE__ */ jsx(RevealWorkspaceKey, {
			workspaceKey: reveal.workspaceKey,
			onConfirm: finishReveal
		}) : /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "New workspace" }), /* @__PURE__ */ jsx(DialogDescription, { children: "Workspaces are independent collections of blocks. You start as the owner; invite others via Settings." })] }), /* @__PURE__ */ jsxs("form", {
			onSubmit: handleSubmit,
			className: "space-y-4",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [/* @__PURE__ */ jsx(Label, {
						htmlFor: "workspace-name",
						children: "Name"
					}), /* @__PURE__ */ jsx(Input, {
						id: "workspace-name",
						autoFocus: true,
						placeholder: "My workspace",
						value: name,
						onChange: (e) => setName(e.target.value),
						disabled: submitting
					})]
				}),
				/* @__PURE__ */ jsxs("label", {
					className: "flex items-start gap-2 text-sm",
					children: [/* @__PURE__ */ jsx("input", {
						type: "checkbox",
						className: "mt-0.5 size-4",
						checked: encrypted,
						onChange: (e_0) => setEncrypted(e_0.target.checked),
						disabled: submitting
					}), /* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("span", {
						className: "font-medium",
						children: "End-to-end encrypted"
					}), /* @__PURE__ */ jsx("span", {
						className: "block text-xs text-muted-foreground",
						children: "Content is encrypted with a key only you hold. You'll get a key to save — there's no recovery if you lose it. Share it out-of-band to collaborate."
					})] })]
				}),
				error && /* @__PURE__ */ jsx("p", {
					className: "text-sm text-destructive",
					children: error
				}),
				/* @__PURE__ */ jsx(DialogFooter, { children: /* @__PURE__ */ jsx(Button, {
					type: "submit",
					disabled: submitting || !name.trim(),
					children: submitting ? "Creating…" : encrypted ? "Create encrypted workspace" : "Create workspace"
				}) })
			]
		})] }) });
		$[14] = encrypted;
		$[15] = error;
		$[16] = finishReveal;
		$[17] = handleSubmit;
		$[18] = name;
		$[19] = reveal;
		$[20] = submitting;
		$[21] = t5;
	} else t5 = $[21];
	let t6;
	if ($[22] !== open || $[23] !== t4 || $[24] !== t5) {
		t6 = /* @__PURE__ */ jsx(Dialog, {
			open,
			onOpenChange: t4,
			children: t5
		});
		$[22] = open;
		$[23] = t4;
		$[24] = t5;
		$[25] = t6;
	} else t6 = $[25];
	return t6;
}
function RevealWorkspaceKey(t0) {
	const $ = c(53);
	const { workspaceKey, onConfirm } = t0;
	const [copyState, setCopyState] = useState("idle");
	const [confirmInput, setConfirmInput] = useState("");
	let T0;
	let confirmed;
	let t1;
	let t2;
	let t3;
	let t4;
	let t5;
	let t6;
	let t7;
	let t8;
	if ($[0] !== confirmInput || $[1] !== copyState || $[2] !== workspaceKey) {
		const suffix = workspaceKey.slice(-CONFIRM_SUFFIX_LEN);
		let t9;
		if ($[13] !== confirmInput) {
			t9 = confirmInput.trim().toUpperCase();
			$[13] = confirmInput;
			$[14] = t9;
		} else t9 = $[14];
		confirmed = t9 === suffix.toUpperCase();
		let t10;
		if ($[15] !== workspaceKey) {
			t10 = async () => {
				try {
					await navigator.clipboard.writeText(workspaceKey);
					setCopyState("copied");
					window.setTimeout(() => setCopyState("idle"), 1500);
				} catch (t11) {
					console.error("Clipboard write failed", t11);
				}
			};
			$[15] = workspaceKey;
			$[16] = t10;
		} else t10 = $[16];
		const copy = t10;
		let t11;
		if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
			t11 = /* @__PURE__ */ jsx(DialogTitle, { children: "Save your workspace key" });
			$[17] = t11;
		} else t11 = $[17];
		if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
			t7 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t11, /* @__PURE__ */ jsxs(DialogDescription, { children: [
				"This is the only time this key is shown. Save it securely — a password manager is recommended. There is ",
				/* @__PURE__ */ jsx("span", {
					className: "font-medium text-foreground",
					children: "no recovery"
				}),
				" if you lose it: the data becomes permanently unreadable."
			] })] });
			$[18] = t7;
		} else t7 = $[18];
		let t12;
		if ($[19] !== workspaceKey) {
			t12 = /* @__PURE__ */ jsx("code", {
				className: "min-w-0 flex-1 break-all font-mono text-xs",
				children: workspaceKey
			});
			$[19] = workspaceKey;
			$[20] = t12;
		} else t12 = $[20];
		const t13 = copyState === "copied" ? "Copied" : "Copy";
		let t14;
		if ($[21] !== copy || $[22] !== t13) {
			t14 = /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "secondary",
				size: "sm",
				className: "shrink-0",
				onClick: copy,
				children: t13
			});
			$[21] = copy;
			$[22] = t13;
			$[23] = t14;
		} else t14 = $[23];
		if ($[24] !== t12 || $[25] !== t14) {
			t8 = /* @__PURE__ */ jsx("div", {
				className: "min-w-0 space-y-2 rounded-md border bg-muted/40 p-3",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 items-center gap-2",
					children: [t12, t14]
				})
			});
			$[24] = t12;
			$[25] = t14;
			$[26] = t8;
		} else t8 = $[26];
		t5 = "space-y-2";
		if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
			t6 = /* @__PURE__ */ jsxs(Label, {
				htmlFor: "wk-confirm",
				children: [
					"Confirm you saved it — retype the last ",
					CONFIRM_SUFFIX_LEN,
					" characters"
				]
			});
			$[27] = t6;
		} else t6 = $[27];
		T0 = Input;
		t1 = "wk-confirm";
		t2 = "off";
		t3 = true;
		let t15;
		if ($[28] === Symbol.for("react.memo_cache_sentinel")) {
			t15 = /./g;
			$[28] = t15;
		} else t15 = $[28];
		t4 = suffix.replace(t15, "•");
		$[0] = confirmInput;
		$[1] = copyState;
		$[2] = workspaceKey;
		$[3] = T0;
		$[4] = confirmed;
		$[5] = t1;
		$[6] = t2;
		$[7] = t3;
		$[8] = t4;
		$[9] = t5;
		$[10] = t6;
		$[11] = t7;
		$[12] = t8;
	} else {
		T0 = $[3];
		confirmed = $[4];
		t1 = $[5];
		t2 = $[6];
		t3 = $[7];
		t4 = $[8];
		t5 = $[9];
		t6 = $[10];
		t7 = $[11];
		t8 = $[12];
	}
	let t9;
	if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = (e) => setConfirmInput(e.target.value);
		$[29] = t9;
	} else t9 = $[29];
	let t10;
	if ($[30] !== confirmed || $[31] !== onConfirm) {
		t10 = (e_0) => {
			if (e_0.key === "Enter" && confirmed) onConfirm();
		};
		$[30] = confirmed;
		$[31] = onConfirm;
		$[32] = t10;
	} else t10 = $[32];
	let t11;
	if ($[33] !== T0 || $[34] !== confirmInput || $[35] !== t1 || $[36] !== t10 || $[37] !== t2 || $[38] !== t3 || $[39] !== t4) {
		t11 = /* @__PURE__ */ jsx(T0, {
			id: t1,
			autoComplete: t2,
			autoFocus: t3,
			placeholder: t4,
			value: confirmInput,
			onChange: t9,
			onKeyDown: t10
		});
		$[33] = T0;
		$[34] = confirmInput;
		$[35] = t1;
		$[36] = t10;
		$[37] = t2;
		$[38] = t3;
		$[39] = t4;
		$[40] = t11;
	} else t11 = $[40];
	let t12;
	if ($[41] !== t11 || $[42] !== t5 || $[43] !== t6) {
		t12 = /* @__PURE__ */ jsxs("div", {
			className: t5,
			children: [t6, t11]
		});
		$[41] = t11;
		$[42] = t5;
		$[43] = t6;
		$[44] = t12;
	} else t12 = $[44];
	const t13 = !confirmed;
	let t14;
	if ($[45] !== onConfirm || $[46] !== t13) {
		t14 = /* @__PURE__ */ jsx(DialogFooter, { children: /* @__PURE__ */ jsx(Button, {
			type: "button",
			disabled: t13,
			onClick: onConfirm,
			children: "I've saved it"
		}) });
		$[45] = onConfirm;
		$[46] = t13;
		$[47] = t14;
	} else t14 = $[47];
	let t15;
	if ($[48] !== t12 || $[49] !== t14 || $[50] !== t7 || $[51] !== t8) {
		t15 = /* @__PURE__ */ jsxs(Fragment$1, { children: [
			t7,
			t8,
			t12,
			t14
		] });
		$[48] = t12;
		$[49] = t14;
		$[50] = t7;
		$[51] = t8;
		$[52] = t15;
	} else t15 = $[52];
	return t15;
}
//#endregion
export { CreateWorkspaceDialog };

//# sourceMappingURL=CreateWorkspaceDialog.js.map