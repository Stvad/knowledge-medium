//#region src/data/typeColors.ts
var DEFAULT_TYPE_COLORS = [
	"oklch(0.62 0.21 25)",
	"oklch(0.70 0.17 55)",
	"oklch(0.76 0.15 90)",
	"oklch(0.72 0.19 130)",
	"oklch(0.60 0.15 155)",
	"oklch(0.72 0.13 185)",
	"oklch(0.64 0.14 220)",
	"oklch(0.58 0.20 262)",
	"oklch(0.66 0.20 292)",
	"oklch(0.58 0.22 315)",
	"oklch(0.68 0.24 340)",
	"oklch(0.62 0.20 5)"
];
/** Deterministic palette entry for a type with NO persisted color —
*  FNV-1a of the id. Hashing the ID (not the label) keeps the color
*  stable across renames and identical across devices (ids sync; a
*  fresh random draw per device/session would flicker and diverge).
*  Pure functions of the id collide (birthday problem), which is why
*  type CREATION persists a least-used pick instead — this is the
*  fallback for code-contributed and imported types. */
var defaultTypeColor = (typeId) => {
	let hash = 2166136261;
	for (let i = 0; i < typeId.length; i++) {
		hash ^= typeId.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return DEFAULT_TYPE_COLORS[(hash >>> 0) % DEFAULT_TYPE_COLORS.length];
};
/** The palette entry currently carried by the fewest TAG-LIKE types —
*  what `createTypeBlock` stamps onto a new type so fresh types spread
*  across the wheel instead of colliding like a pure hash would.
*  Tag-like = chip-visible AND completion-offered: chip-hidden types
*  never show a color, and plumbing chips (`hideFromCompletion` —
*  panel, user, prefs containers) appear too rarely to co-occur with
*  real tags to be worth burning half the wheel's headroom on a fresh
*  workspace. Counts each type's EFFECTIVE color: its configured color
*  when that is a palette entry, its hash fallback otherwise
*  (off-palette custom colors don't occupy a bucket). Deterministic:
*  ties break in palette order. */
var pickLeastUsedTypeColor = (types) => {
	const counts = new Map(DEFAULT_TYPE_COLORS.map((color) => [color, 0]));
	for (const type of types) {
		if (type.hideFromBlockDisplay === true || type.hideFromCompletion === true) continue;
		const effective = type.color?.trim() || defaultTypeColor(type.id);
		const count = counts.get(effective);
		if (count !== void 0) counts.set(effective, count + 1);
	}
	let best = DEFAULT_TYPE_COLORS[0];
	let bestCount = Infinity;
	for (const color of DEFAULT_TYPE_COLORS) {
		const count = counts.get(color);
		if (count < bestCount) {
			best = color;
			bestCount = count;
		}
	}
	return best;
};
//#endregion
export { DEFAULT_TYPE_COLORS, defaultTypeColor, pickLeastUsedTypeColor };

//# sourceMappingURL=typeColors.js.map