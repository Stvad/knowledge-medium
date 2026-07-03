//#region src/plugins/character-counter/charCount.ts
/** `limit` undefined / non-finite / non-positive ≡ "no limit": bare count,
*  never over. A positive limit yields `count / limit` and `over` once the
*  count passes it (strictly greater — being exactly at the limit is fine). */
var charCountDisplay = (length, limit) => {
	if (!(typeof limit === "number" && Number.isFinite(limit) && limit > 0)) return {
		text: String(length),
		over: false
	};
	return {
		text: `${length} / ${limit}`,
		over: length > limit
	};
};
//#endregion
export { charCountDisplay };

//# sourceMappingURL=charCount.js.map