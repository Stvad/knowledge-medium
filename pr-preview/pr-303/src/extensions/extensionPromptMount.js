import { systemToggle } from "../facets/togglable.js";
import { appMountsFacet } from "./core.js";
import { dismissToast, showInfo } from "../utils/toast.js";
import { useRepo } from "../context/repo.js";
import { refreshAppRuntime } from "../facets/runtimeEvents.js";
import { useExtensionApprovalStatuses } from "./extensionApprovalStatus.js";
import { approveExtensionHere } from "./approveExtensionHere.js";
import { extensionPromptDismissals, useExtensionPromptDismissals } from "./extensionPromptDismissals.js";
import { extensionPromptStore, pendingExtensionPrompts } from "./extensionPromptStore.js";
import { extensionPromptDiagnosticContribution } from "./extensionPromptStatus.js";
import { useEffect, useRef } from "react";
import { c } from "react/compiler-runtime";
//#region src/extensions/extensionPromptMount.tsx
/**
* Global surface for extension trust prompts (issue #67 follow-up): the
* `needs-approval` / `update-available` statuses used to render ONLY inside
* the Extensions settings page. This app-mount surfaces them everywhere —
* one persistent toast per pending extension, plus (via
* `extensionPromptStatus.ts`) a quiet status-chip indicator.
*
* Mirrors the app-BUILD update surface (`appUpdateMount.tsx` +
* `appUpdateStatus.ts`): a loud, dismissible toast paired with an always-
* there chip indicator. The difference is that there are N extensions, so:
*
*   - Each toast is keyed by `ext-approval:<blockId>` and its Enable/Update
*     and Dismiss buttons act on THAT block only — fixing the reported bug
*     where enabling one extension dismissed a different one's prompt.
*   - Dismiss persists per-extension (device-local, pinned to the source
*     hash) so it survives reloads; the extension still shows in settings
*     with a working Enable/Update button.
*
* Dismiss model (design C): a toast renders only for NON-dismissed prompts,
* so Dismiss silences the loud nag. But the chip diagnostic is fed the FULL
* pending set (dismissed included) — dismissing drops the toast and the
* chip's ambient dot, yet leaves a quiet "Review" row as a breadcrumb.
*
* The driver reads the per-provider approval store (via context) — so it
* lives under `AppRuntimeProvider` — and publishes the full pending set into
* the `extensionPromptStore` singleton the chip diagnostic reads.
*/
var toastId = (blockId) => `ext-approval:${blockId}`;
/** A prompt's toast content signature — reshow only when this changes, so an
*  unchanged toast isn't torn down and re-animated on every re-publish. */
var toastSignature = (prompt) => `${prompt.kind}:${prompt.liveHash}`;
var promptMessage = (prompt) => prompt.kind === "needs-approval" ? `“${prompt.name}” isn't enabled on this device` : `“${prompt.name}” has an update available`;
var primaryLabel = (prompt) => prompt.kind === "needs-approval" ? "Enable" : "Update";
var showPromptToast = (repo, prompt) => {
	showInfo(promptMessage(prompt), {
		id: toastId(prompt.blockId),
		duration: Number.POSITIVE_INFINITY,
		action: {
			label: primaryLabel(prompt),
			onClick: () => {
				approveExtensionHere(repo, prompt.blockId, prompt.name).then((ok) => {
					if (!ok) {
						showPromptToast(repo, prompt);
						return;
					}
					extensionPromptDismissals.clear(prompt.blockId);
					refreshAppRuntime();
				});
			}
		},
		cancel: {
			label: "Dismiss",
			onClick: () => extensionPromptDismissals.dismiss(prompt.blockId, prompt.liveHash)
		}
	});
};
var ExtensionPromptSurface = () => {
	const $ = c(15);
	const repo = useRepo();
	const statuses = useExtensionApprovalStatuses();
	const dismissals = useExtensionPromptDismissals();
	let t0;
	if ($[0] !== dismissals || $[1] !== statuses) {
		t0 = pendingExtensionPrompts(statuses, dismissals);
		$[0] = dismissals;
		$[1] = statuses;
		$[2] = t0;
	} else t0 = $[2];
	const pending = t0;
	let t1;
	if ($[3] !== pending) {
		t1 = pending.filter(_temp);
		$[3] = pending;
		$[4] = t1;
	} else t1 = $[4];
	const toasts = t1;
	let t2;
	let t3;
	if ($[5] !== pending) {
		t2 = () => {
			extensionPromptStore.set(pending);
		};
		t3 = [pending];
		$[5] = pending;
		$[6] = t2;
		$[7] = t3;
	} else {
		t2 = $[6];
		t3 = $[7];
	}
	useEffect(t2, t3);
	let t4;
	if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ new Map();
		$[8] = t4;
	} else t4 = $[8];
	const shown = useRef(t4);
	let t5;
	let t6;
	if ($[9] !== repo || $[10] !== toasts) {
		t5 = () => {
			const next = /* @__PURE__ */ new Map();
			for (const prompt of toasts) {
				const id = toastId(prompt.blockId);
				const signature = toastSignature(prompt);
				next.set(id, signature);
				if (shown.current.get(id) !== signature) showPromptToast(repo, prompt);
			}
			for (const id_0 of shown.current.keys()) if (!next.has(id_0)) dismissToast(id_0);
			shown.current = next;
		};
		t6 = [toasts, repo];
		$[9] = repo;
		$[10] = toasts;
		$[11] = t5;
		$[12] = t6;
	} else {
		t5 = $[11];
		t6 = $[12];
	}
	useEffect(t5, t6);
	let t7;
	let t8;
	if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = () => () => {
			extensionPromptStore.set([]);
			for (const id_1 of shown.current.keys()) dismissToast(id_1);
			shown.current.clear();
		};
		t8 = [];
		$[13] = t7;
		$[14] = t8;
	} else {
		t7 = $[13];
		t8 = $[14];
	}
	useEffect(t7, t8);
	return null;
};
var extensionPromptsExtension = systemToggle({
	id: "system:extension-prompts",
	name: "Extension prompts",
	description: "Surfaces extensions that need enabling or have an update outside the settings page — a per-extension toast plus a quiet indicator in the status chip."
}).of([appMountsFacet.of({
	id: "core.extension-prompts",
	component: ExtensionPromptSurface
}, { source: "core" }), extensionPromptDiagnosticContribution]);
function _temp(p) {
	return !p.dismissed;
}
//#endregion
export { ExtensionPromptSurface, extensionPromptsExtension };

//# sourceMappingURL=extensionPromptMount.js.map