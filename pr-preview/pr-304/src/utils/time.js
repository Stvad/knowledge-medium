//#region src/utils/time.ts
/** Convert "HH:MM:SS(.mmm)" or "MM:SS" to seconds as float. */
function hmsToSeconds(hms) {
	const parts = hms.split(":").map(Number);
	const [h, m, s] = parts.length === 3 ? parts : [
		0,
		parts[0],
		parts[1]
	];
	return h * 3600 + m * 60 + s;
}
//#endregion
export { hmsToSeconds };

//# sourceMappingURL=time.js.map