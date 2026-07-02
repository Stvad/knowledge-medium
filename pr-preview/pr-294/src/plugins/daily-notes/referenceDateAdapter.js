import { formatRoamDate } from "../../utils/dailyPage.js";
import { parseOutermostReferences, renderWikilink } from "../references/referenceParser.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
//#region src/plugins/daily-notes/referenceDateAdapter.ts
var isoToLocalDate = (iso) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!match) throw new Error(`Invalid ISO date: ${iso}`);
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};
var dateReferenceMatches = (content) => parseOutermostReferences(content).flatMap((ref) => {
	const parsed = parseLiteralDailyPageTitle(ref.alias);
	if (!parsed) return [];
	return [{
		ref,
		iso: parsed.iso,
		style: ref.alias.trim() === parsed.iso ? "iso" : "long"
	}];
});
var singleDateReferenceMatch = (content) => {
	const matches = dateReferenceMatches(content);
	return matches.length === 1 ? matches[0] : null;
};
var replaceSingleDateReferenceContent = (content, iso) => {
	const match = singleDateReferenceMatch(content);
	if (!match) return null;
	const nextAlias = match.style === "iso" ? iso : formatRoamDate(isoToLocalDate(iso));
	return content.slice(0, match.ref.startIndex) + renderWikilink(nextAlias) + content.slice(match.ref.endIndex);
};
var REFERENCE_DATE_ADAPTER_ID = "daily-notes.reference";
var referenceDateAdapter = {
	id: REFERENCE_DATE_ADAPTER_ID,
	canHandle: (block) => {
		const data = block.peek();
		if (!data) return false;
		return singleDateReferenceMatch(data.content) !== null;
	},
	getCurrentIso: async (block) => {
		const data = block.peek() ?? await block.load();
		if (!data) return null;
		return singleDateReferenceMatch(data.content)?.iso ?? null;
	},
	setIso: async (block, iso) => {
		if (block.repo.isReadOnly) return false;
		const data = block.peek() ?? await block.load();
		if (!data) return false;
		const nextContent = replaceSingleDateReferenceContent(data.content, iso);
		if (nextContent === null || nextContent === data.content) return false;
		await block.setContent(nextContent);
		return true;
	}
};
var createEditorReferenceDateAdapter = (editorView) => ({
	id: `${REFERENCE_DATE_ADAPTER_ID}.editor`,
	canHandle: () => singleDateReferenceMatch(editorView.state.doc.toString()) !== null,
	getCurrentIso: async () => singleDateReferenceMatch(editorView.state.doc.toString())?.iso ?? null,
	setIso: async (block, iso) => {
		if (block.repo.isReadOnly) return false;
		const sourceContent = editorView.state.doc.toString();
		const nextContent = replaceSingleDateReferenceContent(sourceContent, iso);
		if (nextContent === null || nextContent === sourceContent) return false;
		editorView.dispatch({ changes: {
			from: 0,
			to: editorView.state.doc.length,
			insert: nextContent
		} });
		await block.setContent(nextContent);
		return true;
	}
});
//#endregion
export { createEditorReferenceDateAdapter, referenceDateAdapter, replaceSingleDateReferenceContent, singleDateReferenceMatch };

//# sourceMappingURL=referenceDateAdapter.js.map