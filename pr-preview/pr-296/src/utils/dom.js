//#region src/utils/dom.ts
var isElementProperlyVisible = (element) => {
	const rect = element.getBoundingClientRect();
	const windowHeight = window.innerHeight || document.documentElement.clientHeight;
	const elementHeight = rect.height;
	const computedStyle = window.getComputedStyle(element);
	const minVisibleHeight = parseFloat(computedStyle.lineHeight) || parseFloat(computedStyle.fontSize) * 1.2;
	const visibleTop = Math.max(0, rect.top);
	const visibleBottom = Math.min(windowHeight, rect.bottom);
	const visibleHeight = Math.max(0, visibleBottom - visibleTop);
	if (elementHeight <= windowHeight) return visibleHeight >= minVisibleHeight;
	const heightRatio = visibleHeight / windowHeight;
	const elementVisibilityRatio = visibleHeight / elementHeight;
	return heightRatio >= .6 || elementVisibilityRatio >= .2 || visibleHeight >= minVisibleHeight;
};
var isEditorElement = (element) => {
	if (!element) return false;
	return element instanceof HTMLTextAreaElement || Boolean(element.closest(".cm-editor"));
};
var shouldExitEditModeAfterBlur = (activeElement) => !isEditorElement(activeElement);
//#endregion
export { isEditorElement, isElementProperlyVisible, shouldExitEditModeAfterBlur };

//# sourceMappingURL=dom.js.map