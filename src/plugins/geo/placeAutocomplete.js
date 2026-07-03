import { EditorSelection } from "../../../node_modules/@codemirror/state/dist/index.js";
import { isInsideLiteralMarkdown } from "../../editor/syntaxContext.js";
import { matchCharTrigger } from "../../editor/triggerMatch.js";
//#region src/plugins/geo/placeAutocomplete.ts
/** CodeMirror CompletionSource for the `@` place trigger.
*
*  Trigger shape: `@<query>` at start of line or after whitespace, with
*  no `[` in the query (so we don't fire inside `[[`) and no preceding
*  word character (so we don't fire mid-email `a@b`). The query may
*  contain single spaces ("Blue Bottle Coffee") — a double space, other
*  whitespace, or the length/word caps end it so prose after a bare
*  `@word` doesn't keep the dropdown alive. The query may be empty —
*  that's the moment to surface the "Use current location" sentinel
*  (Phase F).
*
*  On select: the caller-supplied `resolvePlace` returns a
*  `PlaceResolveResult`. Two kinds:
*    - `{kind: 'insert', name}` → we replace the trigger span with
*      `[[<name>]]` (the references plugin picks up the wikilink).
*    - `{kind: 'handled'}` → the resolver dispatched its own change /
*      opened a follow-up picker; the source stays out of the way.
*  Returning `null` cancels the insertion (user dismissed a sub-prompt).
*
*  Follow-up pickers (Phase F current-location list) re-enter the
*  source via `consumePendingCandidates`: a one-shot stash of
*  candidates + span that the caller pushes from a candidate's apply
*  handler, then triggers `startCompletion(view)` so CM re-opens the
*  dropdown with the new list — no second UI to maintain.
*
*  The source is *pure* w.r.t. data access — it takes already-resolved
*  candidates and a `resolvePlace` callback. Wiring to the repo, the
*  Google client, and `createOrFindPlace` happens in the geo plugin's
*  CodeMirror extension. */
/** `@` trigger detection — the shared matcher (see
*  `src/editor/triggerMatch.ts` for the query/guard semantics: single
*  spaces allowed for multi-word place names, email guard, wikilink
*  ownership, length/word caps). Exported for direct testing. */
var matchAtTrigger = (text, pos) => matchCharTrigger(text, pos, "@");
/** Where to apply the trigger-text → wikilink replacement once the
*  resolution settles. Prefers the recorded span if the text is still
*  there; re-locates by content when the doc drifted around it (other
*  edits landed while the resolution was pending); `null` when the
*  trigger text is gone — the user deleted it, nothing to replace.
*  Exported for direct testing. */
var planResolvedInsert = (doc, span, triggerText) => {
	if (triggerText.length === 0) return null;
	if (doc.slice(span.from, span.to) === triggerText) return span;
	const idx = doc.indexOf(triggerText);
	if (idx === -1) return null;
	return {
		from: idx,
		to: idx + triggerText.length
	};
};
/** Try to deliver the insert through the editor view. False when the
*  view is unmounted/destroyed or the trigger text is no longer in its
*  doc — the caller falls back to `persistInsert`. */
var applyInsertToView = (view, span, triggerText, insert) => {
	if (!view.dom.isConnected) return false;
	const plan = planResolvedInsert(view.state.doc.toString(), span, triggerText);
	if (plan === null) return false;
	try {
		view.dispatch({
			changes: {
				from: plan.from,
				to: plan.to,
				insert
			},
			selection: EditorSelection.cursor(plan.from + insert.length)
		});
		return true;
	} catch {
		return false;
	}
};
var candidateToOption = (candidate, options) => ({
	label: candidate.label,
	detail: candidate.detail,
	type: candidate.source === "sentinel:current-location" ? "keyword" : "class",
	apply: (view, _completion, applyFrom, applyTo) => {
		const triggerText = view.state.doc.sliceString(applyFrom, applyTo);
		(async () => {
			const resolved = await options.resolvePlace(candidate, {
				view,
				from: applyFrom,
				to: applyTo
			});
			if (!resolved) return;
			if (resolved.kind === "handled") return;
			const insert = `[[${resolved.name}]]`;
			if (!applyInsertToView(view, {
				from: applyFrom,
				to: applyTo
			}, triggerText, insert)) await options.persistInsert?.({
				triggerText,
				insert
			});
		})();
	}
});
var placeCompletionSource = (options) => {
	return async (context) => {
		const pending = options.consumePendingCandidates?.();
		if (pending) return {
			from: pending.span.from,
			to: pending.span.to,
			filter: false,
			options: pending.candidates.map((c) => candidateToOption(c, options))
		};
		const { state, pos, explicit } = context;
		const line = state.doc.lineAt(pos);
		const lineText = line.text;
		const match = matchAtTrigger(lineText, pos - line.from);
		if (!match) return null;
		if (isInsideLiteralMarkdown(state, pos)) return null;
		const candidates = await options.getCandidates(match.query);
		if (candidates.length === 0 && !explicit) return null;
		return {
			from: line.from + match.from,
			to: pos,
			filter: false,
			options: candidates.map((c) => candidateToOption(c, options))
		};
	};
};
//#endregion
export { matchAtTrigger, placeCompletionSource, planResolvedInsert };

//# sourceMappingURL=placeAutocomplete.js.map