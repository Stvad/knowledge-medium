//#region src/utils/propertyNavigation.ts
var PROPERTY_CREATE_REQUEST_EVENT = "tm:property-create-request";
var propertyCreateRequestSeq = 0;
var pendingCreateRequests = /* @__PURE__ */ new Map();
var requestPropertyCreate = (args) => {
	const detail = {
		blockId: args.blockId,
		initialName: args.initialName ?? "",
		seq: ++propertyCreateRequestSeq
	};
	pendingCreateRequests.set(args.blockId, detail);
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROPERTY_CREATE_REQUEST_EVENT, { detail }));
	return detail;
};
var consumePendingPropertyCreateRequest = (blockId) => {
	const detail = pendingCreateRequests.get(blockId);
	if (detail) pendingCreateRequests.delete(blockId);
	return detail;
};
var subscribePropertyCreateRequests = (blockId, handler) => {
	if (typeof window === "undefined") return () => {};
	const listener = (event) => {
		const detail = event.detail;
		if (!detail || detail.blockId !== blockId) return;
		pendingCreateRequests.delete(blockId);
		handler(detail);
	};
	window.addEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener);
	return () => window.removeEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener);
};
var PROPERTY_ROW_SELECTOR = "[data-property-row=\"true\"]";
var PROPERTY_LABEL_SELECTOR = "[data-property-label=\"true\"]";
var PROPERTY_VALUE_SELECTOR = "[data-property-value=\"true\"]";
var PROPERTY_ROW_CONTROL_SELECTOR = "[data-property-row-control=\"true\"]";
var PROPERTY_FOCUSABLE_SELECTOR = [
	"input:not([disabled])",
	"textarea:not([disabled])",
	"select:not([disabled])",
	"[contenteditable=\"true\"]",
	"button:not([disabled])",
	"[tabindex]:not([tabindex=\"-1\"])"
].join(",");
var isVisibleElement = (element) => {
	if (typeof window === "undefined" || !window.getComputedStyle) return true;
	const style = window.getComputedStyle(element);
	return style.display !== "none" && style.visibility !== "hidden";
};
var isFocusableElement = (element) => {
	if (!isVisibleElement(element)) return false;
	if ("disabled" in element && element.disabled === true) return false;
	return true;
};
var focusableWithin = (row, selector) => {
	const root = row.querySelector(selector);
	if (!root) return [];
	return [...root.matches(PROPERTY_FOCUSABLE_SELECTOR) || root.hasAttribute("tabindex") ? [root] : [], ...Array.from(root.querySelectorAll(PROPERTY_FOCUSABLE_SELECTOR))].filter(isFocusableElement);
};
var focusableFallbacks = (row) => Array.from(row.querySelectorAll(PROPERTY_FOCUSABLE_SELECTOR)).filter((element) => !element.closest(PROPERTY_ROW_CONTROL_SELECTOR)).filter(isFocusableElement);
var getPropertyRows = (blockId) => {
	if (typeof document === "undefined") return [];
	return Array.from(document.querySelectorAll(PROPERTY_ROW_SELECTOR)).filter((row) => row.dataset.blockId === blockId && isVisibleElement(row));
};
var getPropertyRowFocusTarget = (row, edge = "end") => {
	const labelTargets = focusableWithin(row, PROPERTY_LABEL_SELECTOR);
	const valueTargets = focusableWithin(row, PROPERTY_VALUE_SELECTOR);
	return (edge === "start" ? [...labelTargets, ...valueTargets] : [...valueTargets, ...labelTargets])[0] ?? focusableFallbacks(row)[0] ?? null;
};
var placeCaret = (target, edge) => {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		const pos = edge === "start" ? 0 : target.value.length;
		try {
			target.setSelectionRange(pos, pos);
		} catch {}
	}
};
var focusPropertyRowElement = (row, edge = "end") => {
	const target = getPropertyRowFocusTarget(row, edge);
	if (!target) return false;
	target.focus();
	placeCaret(target, edge);
	return true;
};
var focusPropertyRow = (blockId, position) => {
	const rows = getPropertyRows(blockId);
	const row = position === "first" ? rows[0] : rows.at(-1);
	return row ? focusPropertyRowElement(row, position === "first" ? "start" : "end") : false;
};
var focusPropertyRowByName = (blockId, name) => {
	const row = getPropertyRows(blockId).find((candidate) => candidate.dataset.propertyName === name);
	return row ? focusPropertyRowElement(row) : false;
};
var focusPropertyRowByNameWhenReady = (blockId, name, attempts = 8) => {
	if (focusPropertyRowByName(blockId, name)) return;
	if (attempts <= 0 || typeof requestAnimationFrame === "undefined") return;
	requestAnimationFrame(() => focusPropertyRowByNameWhenReady(blockId, name, attempts - 1));
};
var focusAdjacentPropertyRow = (blockId, currentRow, direction) => {
	const rows = getPropertyRows(blockId);
	const index = rows.indexOf(currentRow);
	if (index < 0) return false;
	const next = rows[index + direction];
	return next ? focusPropertyRowElement(next, direction < 0 ? "end" : "start") : false;
};
//#endregion
export { PROPERTY_CREATE_REQUEST_EVENT, consumePendingPropertyCreateRequest, focusAdjacentPropertyRow, focusPropertyRow, focusPropertyRowByName, focusPropertyRowByNameWhenReady, focusPropertyRowElement, getPropertyRowFocusTarget, getPropertyRows, requestPropertyCreate, subscribePropertyCreateRequests };

//# sourceMappingURL=propertyNavigation.js.map