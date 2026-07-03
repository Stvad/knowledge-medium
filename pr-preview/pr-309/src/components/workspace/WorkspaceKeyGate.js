import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { confirmPlaintextForSession, setModePin } from "../../sync/keys/modePin.js";
import { getWorkspaceKeyStore } from "../../sync/keys/keyStore.js";
import { Label } from "../ui/label.js";
import { unlockWorkspaceWithKey } from "../../sync/keys/flows/unlockWorkspaceWithKey.js";
import { useState } from "react";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/workspace/WorkspaceKeyGate.tsx
/**
* §6 rule 3 / §8.2 — the read-only gate shown in place of a workspace whose
* content can't be rendered yet: an E2EE workspace missing its key, or an
* unverified (never-pinned, server-says-none) workspace. The user resolves it
* by pasting the out-of-band workspace key, or — only in the quarantine case —
* by confirming the workspace really is plaintext.
*/
function WorkspaceKeyGate({ userId, workspaceId, workspaceName, reason, canary, onResolved }) {
	const [pasted, setPasted] = useState("");
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	const submitKey = async () => {
		const trimmed = pasted.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await unlockWorkspaceWithKey({
				userId,
				workspaceId,
				canary: canary ?? "",
				pastedKey: trimmed,
				keyStore: getWorkspaceKeyStore()
			});
			if (result.ok) {
				await onResolved();
				return;
			}
			setBusy(false);
			setError(result.reason === "format" ? "That doesn't look like a workspace key (expected kmp-wk-1:…)." : result.reason === "storage" ? "Your key is correct, but it couldn't be saved on this device (storage may be full or blocked). Try again." : "That key doesn't decrypt this workspace's data.");
		} catch (err) {
			setBusy(false);
			setError(err instanceof Error ? err.message : "Could not unlock this workspace.");
		}
	};
	const confirmPlaintext = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			setModePin(userId, workspaceId, "plaintext");
		} catch (err_0) {
			console.warn("[gate] plaintext pin persist failed; confirming for this session only", err_0);
			confirmPlaintextForSession(userId, workspaceId);
		}
		try {
			await onResolved();
		} catch (err_1) {
			setBusy(false);
			setError(err_1 instanceof Error ? err_1.message : "Could not load this workspace.");
		}
	};
	const name = workspaceName ? `"${workspaceName}"` : "This workspace";
	return /* @__PURE__ */ jsx("div", {
		className: "flex min-h-svh items-center justify-center p-6",
		children: /* @__PURE__ */ jsxs("div", {
			className: "w-full max-w-md space-y-5 rounded-lg border bg-background p-6 shadow-sm",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-1.5",
					children: [/* @__PURE__ */ jsx("h1", {
						className: "text-lg font-semibold",
						children: reason === "key-required" ? `${name} needs its key` : `${name} isn't verified`
					}), /* @__PURE__ */ jsx("p", {
						className: "text-sm text-muted-foreground",
						children: reason === "key-required" ? /* @__PURE__ */ jsx(Fragment$1, { children: "Its content is end-to-end encrypted. Paste the workspace key you saved (or were sent) to unlock it on this device. It stays on this device only." }) : /* @__PURE__ */ jsx(Fragment$1, { children: "We can't confirm whether this workspace is encrypted. If you have a workspace key for it, paste it to unlock. Otherwise, if you know it's a plain (unencrypted) workspace, you can confirm that below." })
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [
						/* @__PURE__ */ jsx(Label, {
							htmlFor: "wk-paste",
							children: "Workspace key"
						}),
						/* @__PURE__ */ jsx(Input, {
							id: "wk-paste",
							autoFocus: true,
							autoComplete: "off",
							placeholder: "kmp-wk-1:…",
							value: pasted,
							disabled: busy,
							onChange: (e) => setPasted(e.target.value),
							onKeyDown: (e_0) => {
								if (e_0.key === "Enter") submitKey();
							}
						}),
						error && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-destructive",
							children: error
						}),
						/* @__PURE__ */ jsx(Button, {
							type: "button",
							className: "w-full",
							disabled: busy || !pasted.trim(),
							onClick: () => void submitKey(),
							children: busy ? "Unlocking…" : "Unlock"
						})
					]
				}),
				reason === "quarantine" && /* @__PURE__ */ jsxs("div", {
					className: "border-t pt-4",
					children: [/* @__PURE__ */ jsx("p", {
						className: "mb-2 text-xs text-muted-foreground",
						children: "No key because it's not encrypted? Confirm to load it as a plain workspace. This choice is permanent for this workspace on every device."
					}), /* @__PURE__ */ jsx(Button, {
						type: "button",
						variant: "secondary",
						className: "w-full",
						disabled: busy,
						onClick: () => void confirmPlaintext(),
						children: busy ? "Confirming…" : "This workspace is not encrypted"
					})]
				})
			]
		})
	});
}
//#endregion
export { WorkspaceKeyGate };

//# sourceMappingURL=WorkspaceKeyGate.js.map