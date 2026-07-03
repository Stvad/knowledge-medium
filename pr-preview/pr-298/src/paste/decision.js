import { defineVerbFacet } from "../facets/verbFacet.js";
//#region src/paste/decision.ts
/**
* The historical paste decision, now the replaceable `defaultImpl` of the
* paste verb:
*   - `single-block` chord → verbatim into the current block.
*   - plain chord with a newline → split into an outline.
*   - plain chord, single line → `single-block` in the `editor` (a verbatim
*     caret insert, like the browser's native paste) but `split` in the
*     `shell` (no caret; parse as an outline, the historical behavior).
*
* Because the default never returns `single-block` for a single-line shell
* paste, the shell can honor `single-block` literally (no extra guard): the
* applied behavior always matches the decision, and an "always paste
* verbatim" plugin works on single-line shell pastes too.
*/
var defaultPasteDecision = (request) => {
	if (request.intent === "single-block") return { kind: "single-block" };
	if (request.text.includes("\n")) return { kind: "split" };
	return request.surface === "editor" ? { kind: "single-block" } : { kind: "split" };
};
/**
* The paste verb — the first home of `defineVerbFacet` outside
* navigation. Decides, per paste, how clipboard content lands in the
* outline. Plugins contribute:
*   - `pasteDecisionVerb.impl(fn)`      — replace the decision wholesale,
*   - `pasteDecisionVerb.decorator(fn)` — wrap it (e.g. rewrite CSV →
*     markdown then defer to `next`),
*   - `pasteDecisionVerb.before/after`  — observe pastes.
* With no contributions the decision is `defaultPasteDecision`, so the editor
* behaves exactly as before the seam existed. Call sites resolve it with
* `runSync` (the decision is pure and is needed at the synchronous
* `preventDefault` boundary), so `impl`/`decorator` contributions must be
* **synchronous** — an async one violates the contract and falls back to
* `defaultPasteDecision` (these are pure policy with no I/O; async before/after
* observers are still fine, they're fire-and-forget).
*/
var pasteDecisionVerb = defineVerbFacet({
	id: "core.paste-decision",
	defaultImpl: defaultPasteDecision,
	onError: "fallback",
	validateResult: (decision) => decision != null && (decision.kind === "single-block" || decision.kind === "split" || decision.kind === "media") && (decision.text === void 0 || typeof decision.text === "string")
});
//#endregion
export { defaultPasteDecision, pasteDecisionVerb };

//# sourceMappingURL=decision.js.map