//#region src/plugins/find-replace/search.ts
var DEFAULT_FIND_REPLACE_OPTIONS = {
	matchCase: false,
	wholeWord: false
};
var isWordChar = (char) => char !== void 0 && /[A-Za-z0-9_]/.test(char);
var passesWholeWordBoundary = (content, needle, index) => {
	const first = needle[0];
	const last = needle[needle.length - 1];
	const before = content[index - 1];
	const after = content[index + needle.length];
	return (!isWordChar(first) || !isWordChar(before)) && (!isWordChar(last) || !isWordChar(after));
};
var findLiteralMatches = (content, needle, options) => {
	if (needle.length === 0) return [];
	const haystack = options.matchCase ? content : content.toLocaleLowerCase();
	const target = options.matchCase ? needle : needle.toLocaleLowerCase();
	const matches = [];
	let start = 0;
	for (;;) {
		const index = haystack.indexOf(target, start);
		if (index < 0) break;
		if (!options.wholeWord || passesWholeWordBoundary(content, needle, index)) matches.push({
			index,
			length: needle.length
		});
		start = index + needle.length;
	}
	return matches;
};
var replaceLiteralMatches = (content, find, replace, options) => {
	const matches = findLiteralMatches(content, find, options);
	if (matches.length === 0) return {
		content,
		replacementCount: 0
	};
	let cursor = 0;
	let next = "";
	for (const match of matches) {
		next += content.slice(cursor, match.index);
		next += replace;
		cursor = match.index + match.length;
	}
	next += content.slice(cursor);
	return {
		content: next,
		replacementCount: matches.length
	};
};
var compactWhitespace = (text) => text.replace(/\s+/g, " ").trim();
var previewForMatch = (content, match, contextChars = 48) => {
	const start = Math.max(0, match.index - contextChars);
	const end = Math.min(content.length, match.index + match.length + contextChars);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return `${prefix}${compactWhitespace(content.slice(start, end))}${suffix}`;
};
var buildContentSearchMatch = (blockId, content, query, options) => {
	const matches = findLiteralMatches(content, query, options);
	const first = matches[0];
	if (first === void 0) return null;
	return {
		blockId,
		originalContent: content,
		matchCount: matches.length,
		preview: previewForMatch(content, first)
	};
};
//#endregion
export { DEFAULT_FIND_REPLACE_OPTIONS, buildContentSearchMatch, findLiteralMatches, previewForMatch, replaceLiteralMatches };

//# sourceMappingURL=search.js.map