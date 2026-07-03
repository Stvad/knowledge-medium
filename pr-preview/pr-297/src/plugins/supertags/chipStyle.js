//#region src/plugins/supertags/chipStyle.ts
/** Contribution-declared chip color, validated so an unparseable value
*  degrades to default styling instead of a half-styled chip. (Inline
*  styles assign via CSSOM, so invalid values can't inject — this is
*  purely a rendering-quality guard.) */
var configuredChipColor = (type) => {
	const color = type.color?.trim();
	if (!color) return void 0;
	if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("color", color)) return void 0;
	return color;
};
/** Deterministic hue for a type with no configured color — FNV-1a of
*  the id onto the hue wheel. Hashing the ID (not the label) keeps the
*  color stable across renames and identical across devices (ids sync;
*  a fresh random draw per device/session would flicker and diverge). */
var typeHue = (typeId) => {
	let hash = 2166136261;
	for (let i = 0; i < typeId.length; i++) {
		hash ^= typeId.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 360;
};
/** Every REGISTERED type gets a color: the configured one verbatim, or
*  a hue hashed from the id. The default's text mixes the hue toward
*  the theme foreground, so one formula yields a dark readable tone on
*  light themes and a light one on dark themes — no dark-variant
*  branch. Unregistered ids return undefined and keep the muted-gray
*  fallback: the missing color is a SIGNAL (definition not synced /
*  plugin disabled), not a styling gap. */
var chipStyle = (type, typeId) => {
	if (!type) return void 0;
	const configured = configuredChipColor(type);
	if (configured) return {
		color: configured,
		backgroundColor: `color-mix(in srgb, ${configured} 14%, transparent)`
	};
	const base = `oklch(0.65 0.17 ${typeHue(typeId)})`;
	return {
		color: `color-mix(in oklch, ${base} 60%, hsl(var(--foreground)))`,
		backgroundColor: `color-mix(in srgb, ${base} 12%, transparent)`
	};
};
//#endregion
export { chipStyle, typeHue };

//# sourceMappingURL=chipStyle.js.map