import { systemToggle } from "../facets/togglable.js";
import { appMountsFacet } from "./core.js";
import { dismissToast, showInfo } from "../utils/toast.js";
import { useRepo } from "../context/repo.js";
import { refreshAppRuntime } from "../facets/runtimeEvents.js";
import { useExtensionApprovalStatuses } from "./extensionApprovalStatus.js";
import { approveExtensionHere } from "./approveExtensionHere.js";
import { extensionPromptDismissals, useExtensionPromptDismissals } from "./extensionPromptDismissals.js";
import { activeExtensionPrompts, extensionPromptStore } from "./extensionPromptStore.js";
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
* there chip fallback. The difference is that there are N extensions, so:
*
*   - Each toast is keyed by `ext-approval:<blockId>` and its Enable/Update
*     and Dismiss buttons act on THAT block only — fixing the reported bug
*     where enabling one extension dismissed a different one's prompt.
*   - Dismiss persists per-extension (device-local, pinned to the source
*     hash) so it survives reloads; the extension still shows in settings
*     with a working Enable/Update button.
*
* The driver reads the per-provider approval store (via context) — so it
* lives under `AppRuntimeProvider` — and publishes the active set into the
* `extensionPromptStore` singleton the chip diagnostic reads.
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
	const $ = c(13);
	const repo = useRepo();
	const statuses = useExtensionApprovalStatuses();
	const dismissals = useExtensionPromptDismissals();
	let t0;
	if ($[0] !== dismissals || $[1] !== statuses) {
		t0 = activeExtensionPrompts(statuses, dismissals);
		$[0] = dismissals;
		$[1] = statuses;
		$[2] = t0;
	} else t0 = $[2];
	const active = t0;
	let t1;
	let t2;
	if ($[3] !== active) {
		t1 = () => {
			extensionPromptStore.set(active);
		};
		t2 = [active];
		$[3] = active;
		$[4] = t1;
		$[5] = t2;
	} else {
		t1 = $[4];
		t2 = $[5];
	}
	useEffect(t1, t2);
	let t3;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ new Map();
		$[6] = t3;
	} else t3 = $[6];
	const shown = useRef(t3);
	let t4;
	let t5;
	if ($[7] !== active || $[8] !== repo) {
		t4 = () => {
			const next = /* @__PURE__ */ new Map();
			for (const prompt of active) {
				const id = toastId(prompt.blockId);
				const signature = toastSignature(prompt);
				next.set(id, signature);
				if (shown.current.get(id) !== signature) showPromptToast(repo, prompt);
			}
			for (const id_0 of shown.current.keys()) if (!next.has(id_0)) dismissToast(id_0);
			shown.current = next;
		};
		t5 = [active, repo];
		$[7] = active;
		$[8] = repo;
		$[9] = t4;
		$[10] = t5;
	} else {
		t4 = $[9];
		t5 = $[10];
	}
	useEffect(t4, t5);
	let t6;
	let t7;
	if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = () => () => {
			extensionPromptStore.set([]);
			for (const id_1 of shown.current.keys()) dismissToast(id_1);
			shown.current.clear();
		};
		t7 = [];
		$[11] = t6;
		$[12] = t7;
	} else {
		t6 = $[11];
		t7 = $[12];
	}
	useEffect(t6, t7);
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
//#endregion
export { ExtensionPromptSurface, extensionPromptsExtension };

//# sourceMappingURL=extensionPromptMount.js.map