import { rejectionToastFacet } from "./core.js";
import { showCustom, showError } from "../utils/toast.js";
//#region src/extensions/processorRejectionToast.ts
/** Rejection toasts stay up longer than a transient notice — they're
*  actionable (open / merge / pick a new name). */
var REJECTION_TOAST_DURATION_MS = 12e3;
/** Dispatch one rejection to the renderer contributed for its `code`,
*  wrapping it in `showCustom`. An unknown code falls back to the raw
*  message — better than swallowing silently; any new processor that
*  throws `ProcessorRejection` surfaces SOMETHING until a plugin
*  contributes a tailored toast. Pure (takes the contributions map) so
*  the routing contract is unit-testable. */
var routeProcessorRejection = (error, repo, contributions) => {
	const contribution = contributions.get(error.code);
	if (!contribution) {
		showError(error.message);
		return;
	}
	showCustom((id) => contribution.render(error, repo, id), { duration: REJECTION_TOAST_DURATION_MS });
};
/** Subscribed once at repo construction (`context/repo.tsx`). Reads the
*  rejection-toast contributions off the repo's current runtime, so a
*  single early subscriber covers both the bootstrap window (data-only
*  runtime ⇒ empty ⇒ raw-message fallback) and normal operation (full
*  app runtime ⇒ plugin toasts), and tracks plugin toggles for free.
*
*  CONTRACT: depends on `repo.facetRuntime` carrying app-layer facets —
*  true because `AppRuntimeProvider` installs the merged app runtime via
*  `setFacetRuntime` (see the `repo.facetRuntime` getter doc). If that
*  changes (the runtime-composition work), this read silently returns
*  empty and every rejection degrades to the raw-message fallback —
*  preserve the contract or relocate this read.
*
*  This direct read replaces the older "module-global mirror kept in sync
*  by an app effect" pattern (still used by `runAction`'s dispatcher and
*  theme-toggle's registry); converging those onto this read is left to
*  the runtime-composition work. */
var surfaceProcessorRejection = (error, repo) => routeProcessorRejection(error, repo, repo.facetRuntime?.read(rejectionToastFacet) ?? /* @__PURE__ */ new Map());
//#endregion
export { routeProcessorRejection, surfaceProcessorRejection };

//# sourceMappingURL=processorRejectionToast.js.map