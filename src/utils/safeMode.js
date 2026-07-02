//#region src/utils/safeMode.ts
var hasSafeModeSearchParam = (value) => value !== null;
var searchHasSafeModeFlag = (search) => new URLSearchParams(search).has("safeMode");
var buildSafeModeUrl = (href) => {
	const url = new URL(href);
	url.searchParams.set("safeMode", "");
	return url.toString();
};
var reloadInSafeMode = (location = window.location) => {
	const next = buildSafeModeUrl(location.href);
	if (next === location.href) {
		location.reload();
		return;
	}
	location.assign(next);
};
//#endregion
export { buildSafeModeUrl, hasSafeModeSearchParam, reloadInSafeMode, searchHasSafeModeFlag };

//# sourceMappingURL=safeMode.js.map