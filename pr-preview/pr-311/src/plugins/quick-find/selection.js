import { blockLinkClickIntent } from "../../utils/navigation.js";
//#region src/plugins/quick-find/selection.ts
var quickFindAliasValue = (match) => `page:${match.blockId}:${match.alias}`;
var quickFindBlockValue = (match) => `block:${match.blockId}`;
var quickFindCreateValue = (query) => `create:${query}`;
var quickFindDateValue = (iso) => `date:${iso}`;
var quickFindOpenTargetFromModifiers = ({ shiftKey, altKey, metaKey, ctrlKey }) => {
	if (shiftKey && altKey) return "new-panel";
	if (shiftKey || metaKey || ctrlKey) return "stack";
	return "jump";
};
var quickFindOpenTargetFromClickModifiers = ({ shiftKey = false, altKey = false, metaKey = false, ctrlKey = false, button = 0 }) => {
	const intent = blockLinkClickIntent({
		shiftKey,
		altKey,
		metaKey,
		ctrlKey,
		button
	});
	if (intent === "new-panel") return "new-panel";
	if (intent === "sidebar-stack") return "stack";
	return "jump";
};
var quickFindSelectionAction = (selectedValue, target) => {
	const colonIdx = selectedValue.indexOf(":");
	if (colonIdx === -1) return null;
	const kind = selectedValue.slice(0, colonIdx);
	const payload = selectedValue.slice(colonIdx + 1);
	if (kind === "create") return {
		kind: "create-page",
		alias: payload,
		target
	};
	if (kind === "date") return {
		kind: "open-date",
		iso: payload,
		target
	};
	const blockId = payload.split(":")[0];
	return blockId ? {
		kind: "open-block",
		blockId,
		target
	} : null;
};
var nextQuickFindSelection = ({ query, aliases, blocks, dateValues, currentValue }) => {
	const createValue = quickFindCreateValue(query);
	const visibleValues = [
		...dateValues,
		...aliases.map(quickFindAliasValue),
		...blocks.map(quickFindBlockValue)
	];
	const hasExactAliasMatch = aliases.some((match) => match.alias.toLowerCase() === query.toLowerCase());
	if (dateValues.length === 0 && !hasExactAliasMatch) visibleValues.push(createValue);
	const firstVisibleValue = visibleValues[0];
	if (!firstVisibleValue) return currentValue;
	return currentValue === "" || currentValue === createValue || !visibleValues.includes(currentValue) ? firstVisibleValue : currentValue;
};
//#endregion
export { nextQuickFindSelection, quickFindAliasValue, quickFindBlockValue, quickFindCreateValue, quickFindDateValue, quickFindOpenTargetFromClickModifiers, quickFindOpenTargetFromModifiers, quickFindSelectionAction };

//# sourceMappingURL=selection.js.map