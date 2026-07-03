import { parseReferences } from "../references/referenceParser.js";
//#region src/plugins/roam-import/references.ts
var collectCodeRanges = (content) => {
	const ranges = [];
	let i = 0;
	while (i < content.length) {
		if (content.startsWith("```", i)) {
			const end = content.indexOf("```", i + 3);
			const rangeEnd = end < 0 ? content.length : end + 3;
			ranges.push({
				start: i,
				end: rangeEnd
			});
			i = rangeEnd;
			continue;
		}
		if (content[i] === "`") {
			const end = content.indexOf("`", i + 1);
			if (end < 0) break;
			ranges.push({
				start: i,
				end: end + 1
			});
			i = end + 1;
			continue;
		}
		i += 1;
	}
	return ranges;
};
var inRange = (ranges, index) => ranges.some((range) => index >= range.start && index < range.end);
var parseRoamImportReferences = (content) => {
	const codeRanges = collectCodeRanges(content);
	if (codeRanges.length === 0) return parseReferences(content);
	return parseReferences(content).filter((ref) => !inRange(codeRanges, ref.startIndex));
};
//#endregion
export { parseRoamImportReferences };

//# sourceMappingURL=references.js.map