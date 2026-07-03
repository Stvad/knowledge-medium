import { diagnosticsFacet } from "../plugins/diagnostics/facet.js";
import { extensionPromptStore } from "./extensionPromptStore.js";
import { OPEN_EXTENSIONS_SETTINGS_ACTION_ID } from "../plugins/extensions-settings/actions.js";
//#region src/extensions/extensionPromptStatus.ts
/**
* Routes "extensions need enabling / have updates" onto the shared
* diagnostics seam, so the status chip shows a quiet, always-there indicator
* (an ambient dot + a "Review" row in the dropdown) whenever prompts are
* pending — the fallback for when the loud toast has been dismissed or
* missed. Pairs with the per-extension toasts in `extensionPromptMount.tsx`.
*
* The "Review" action reuses the existing `open_extensions_settings` global
* action (the chip's dropdown button runs it via `runActionById`), landing
* the user on the Extensions settings page where each pending extension has
* its own per-row Enable/Update button.
*
* Mirrors `appUpdateStatus.ts` (the app-build-update analog); the only
* difference is the summary count, which varies with how many extensions are
* pending — so the snapshot is memoized by a content signature to stay
* referentially stable (a `useDiagnostics`/`useSyncExternalStore` need).
*/
var buildSnapshot = (prompts) => {
	if (prompts.length === 0) return null;
	return {
		severity: "info",
		summary: prompts.length === 1 ? "An extension needs review" : `${prompts.length} extensions need review`,
		actionId: OPEN_EXTENSIONS_SETTINGS_ACTION_ID,
		actionLabel: "Review",
		nudge: true
	};
};
var cached = {
	signature: "\0never",
	snapshot: null
};
var signatureOf = (prompts) => prompts.map((p) => `${p.blockId}:${p.kind}:${p.liveHash}`).join("|");
var extensionPromptDiagnosticSource = {
	id: "extension-prompts",
	label: "Extensions",
	subscribe: extensionPromptStore.subscribe,
	getSnapshot: () => {
		const prompts = extensionPromptStore.getSnapshot();
		const signature = signatureOf(prompts);
		if (signature !== cached.signature) cached = {
			signature,
			snapshot: buildSnapshot(prompts)
		};
		return cached.snapshot;
	}
};
var extensionPromptDiagnosticContribution = diagnosticsFacet.of(extensionPromptDiagnosticSource, { source: "extension-prompts" });
//#endregion
export { extensionPromptDiagnosticContribution, extensionPromptDiagnosticSource };

//# sourceMappingURL=extensionPromptStatus.js.map