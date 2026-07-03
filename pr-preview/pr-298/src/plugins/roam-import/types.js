//#region src/plugins/roam-import/types.ts
var getExtraRoamProps = (raw) => {
	if (!raw || typeof raw !== "object") return {};
	const out = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!key.startsWith(":")) continue;
		if (key === ":block/props" || key === ":block/refs" || key === ":create/user" || key === ":edit/user" || key === ":block/uid" || key === ":log/id" || key === ":children/view-type") continue;
		out[key] = value;
	}
	return out;
};
//#endregion
export { getExtraRoamProps };

//# sourceMappingURL=types.js.map