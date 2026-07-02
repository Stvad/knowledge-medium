import { EditorSelection } from "../../../node_modules/@codemirror/state/dist/index.js";
import { matchCharTrigger } from "../../editor/triggerMatch.js";
//#region src/plugins/supertags/typeAutocomplete.ts
/** CodeMirror CompletionSource for the `#` type-tag trigger (Tana-style
*  supertags).
*
*  Trigger detection is the shared `matchCharTrigger`
*  (`src/editor/triggerMatch.ts`, also behind the geo `@` trigger)
*  with the stacked-hash guard on, so markdown headings (`# Title`,
*  `##foo`) and URL anchors never fire it.
*
*  On select the trigger text (`#query`) is deleted from the doc
*  immediately — the tag lives in the block's `types` property and is
*  rendered as a trailing chip by `TypeChipsDecorator`, not as text —
*  and the (async) type write is fired through `pickType`, which also
*  mirrors the deletion into the block's stored content (same tx as
*  the tag) so the editor remount that a types change triggers seeds
*  from a cache row without the trigger text. A failed pick restores
*  the deleted text (view first, stored content as fallback).
*
*  The source is pure w.r.t. data access: it takes already-resolved
*  candidates and a `pickType` callback. Wiring to the repo (the live
*  `typesFacet` registry, `addType`, `createTypeBlock`) happens in the
*  plugin's CodeMirror extension. */
/** The tagging UX hides `structural` contributions (kernel structure
*  like page/panel, plugin prefs/ui-state plumbing — see
*  `TypeContribution.structural`) everywhere, and `hideTag` ones from
*  the chip display only. Unknown ids (type not in the registry, e.g.
*  mid-load) stay visible so a tag never silently disappears. */
var isTaggable = (type) => type === void 0 || type.structural !== true;
/** Which of a block's types display as trailing tag chips: everything
*  except `structural` contributions and types that opt out via
*  `hideTag` (`block-type:hide-tag` on user-defined types). Display-
*  only policy — `buildTypeTagCandidates` deliberately does NOT
*  consult `hideTag`, so a chip-hidden type stays taggable. Dedups:
*  a malformed `types` array (importer/bridge writes) must not render
*  duplicate React keys. */
var visibleTagTypeIds = (typeIds, registry) => {
	const seen = /* @__PURE__ */ new Set();
	return typeIds.filter((typeId) => {
		if (seen.has(typeId)) return false;
		seen.add(typeId);
		const type = registry.get(typeId);
		return isTaggable(type) && type?.hideTag !== true;
	});
};
/** Dropdown length cap. Typing narrows the list, so truncation only
*  ever hides types the query hasn't disambiguated yet. */
var RESULT_CAP = 12;
/** `#` trigger detection — the shared matcher with the stacked-hash
*  guard on (`##foo` is heading territory, not a tag). Exported for
*  direct testing. */
var matchHashTrigger = (text, pos) => matchCharTrigger(text, pos, "#", { rejectDoubledTrigger: true });
var labelOf = (type) => type.label ?? type.id;
/** Case-insensitive exact label/id lookup among TAGGABLE types.
*  Exported for the create flow's just-before-create re-check (the
*  sentinel can be picked before an earlier create publishes). */
var findTaggableTypeByName = (registry, name) => {
	const q = name.trim().toLowerCase();
	if (q === "") return void 0;
	for (const type of registry.values()) {
		if (!isTaggable(type)) continue;
		if (labelOf(type).toLowerCase() === q || type.id.toLowerCase() === q) return type;
	}
};
/** Pure candidate builder over a registry snapshot. Exported for
*  direct testing; the plugin extension feeds it `repo.types` and the
*  block's current `types` property.
*
*  The `create` sentinel appears for any non-empty query with no exact
*  label/id match among the TAGGABLE types (already-applied ones
*  included, so you can't mint a second "Task" from a block that
*  already carries the first). Structural types deliberately don't
*  suppress it: `#page` should offer to create the user's own "page"
*  type rather than dead-end with an empty dropdown. */
var buildTypeTagCandidates = (args) => {
	const trimmed = args.query.trim();
	const q = trimmed.toLowerCase();
	const current = new Set(args.currentTypeIds);
	const matches = Array.from(args.registry.values()).filter((type) => isTaggable(type) && !current.has(type.id) && (q === "" || labelOf(type).toLowerCase().includes(q) || type.id.toLowerCase().includes(q)));
	const rank = (type) => labelOf(type).toLowerCase().startsWith(q) ? 0 : 1;
	matches.sort((a, b) => rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b)));
	const existing = matches.slice(0, RESULT_CAP).map((type) => ({
		kind: "existing",
		id: type.id,
		label: labelOf(type),
		detail: type.description
	}));
	if (trimmed === "" || findTaggableTypeByName(args.registry, trimmed)) return existing;
	return [...existing, {
		kind: "create",
		label: trimmed,
		detail: "Create new type"
	}];
};
/** How `pickType` should mirror the view's trigger deletion into the
*  block's stored content. Strict snapshot equality — anything else
*  (unflushed keystrokes, concurrent edits) returns null and the
*  caller skips the content edit: the editor's own debounced
*  `setContent` carries the deletion in those cases, and a wrong guess
*  here would destroy user text. Pure; exported for direct testing. */
var planTriggerStrip = (storedContent, ctx) => {
	if (storedContent === ctx.docBefore) return ctx.docAfter;
	return null;
};
/** How a FAILED pick's fallback should put the trigger text back into
*  stored content (the view path is preferred; this runs only when the
*  view is unmounted). Exact inverse when the stored content matches
*  the post-deletion snapshot; no-op when the text is demonstrably
*  already there at its spot; best-effort positional insert otherwise
*  (drifted content — restoring the user's text imperfectly placed
*  beats dropping it). Pure; exported for direct testing. */
var planTriggerRestore = (storedContent, ctx) => {
	if (storedContent === ctx.docAfter) return ctx.docBefore;
	if (storedContent.slice(ctx.at, ctx.at + ctx.triggerText.length) === ctx.triggerText) return null;
	const pos = Math.min(ctx.at, storedContent.length);
	return storedContent.slice(0, pos) + ctx.triggerText + storedContent.slice(pos);
};
/** Put a failed pick's trigger text back into the editor at (or as
*  near as the doc allows) its original spot. False when the view is
*  unmounted — the caller falls back to `restoreTrigger`. Exported for
*  direct testing. */
var restoreTriggerToView = (view, at, triggerText) => {
	if (!view.dom.isConnected) return false;
	try {
		const pos = Math.min(at, view.state.doc.length);
		view.dispatch({
			changes: {
				from: pos,
				insert: triggerText
			},
			selection: EditorSelection.cursor(pos + triggerText.length)
		});
		return true;
	} catch {
		return false;
	}
};
var candidateToOption = (candidate, options) => ({
	label: candidate.kind === "create" ? `Create type "${candidate.label}"` : candidate.label,
	detail: candidate.detail,
	type: candidate.kind === "create" ? "keyword" : "class",
	apply: (view, _completion, applyFrom, applyTo) => {
		const docBefore = view.state.doc.toString();
		const triggerText = view.state.doc.sliceString(applyFrom, applyTo);
		view.dispatch({
			changes: {
				from: applyFrom,
				to: applyTo,
				insert: ""
			},
			selection: EditorSelection.cursor(applyFrom)
		});
		const ctx = {
			triggerText,
			at: applyFrom,
			docBefore,
			docAfter: view.state.doc.toString()
		};
		(async () => {
			try {
				await options.pickType(candidate, ctx);
			} catch (err) {
				console.warn("[supertags] failed to apply type", candidate.label, err);
				if (!restoreTriggerToView(view, applyFrom, triggerText)) await options.restoreTrigger?.(ctx).catch((restoreErr) => {
					console.warn("[supertags] failed to restore trigger text", restoreErr);
				});
			}
		})();
	}
});
var typeTagCompletionSource = (options) => {
	return async (context) => {
		const { state, pos, explicit } = context;
		const line = state.doc.lineAt(pos);
		const match = matchHashTrigger(line.text, pos - line.from);
		if (!match) return null;
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
export { buildTypeTagCandidates, findTaggableTypeByName, matchHashTrigger, planTriggerRestore, planTriggerStrip, restoreTriggerToView, typeTagCompletionSource, visibleTagTypeIds };

//# sourceMappingURL=typeAutocomplete.js.map