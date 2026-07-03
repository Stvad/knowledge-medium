import { defaultTypeColor } from "../../data/typeColors.js";
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
/** Every REGISTERED type gets a color: the configured one verbatim, or
*  the hash-fallback palette entry. The default's text mixes the base
*  toward the theme foreground, so one formula yields a dark readable
*  tone on light themes and a light one on dark themes — no
*  dark-variant branch. Unregistered ids return undefined and keep the
*  muted-gray fallback: the missing color is a SIGNAL (definition not
*  synced / plugin disabled), not a styling gap. */
var chipStyle = (type) => {
	if (!type) return void 0;
	const configured = configuredChipColor(type);
	if (configured) return {
		color: configured,
		backgroundColor: `color-mix(in srgb, ${configured} 14%, transparent)`
	};
	const base = defaultTypeColor(type.id);
	return {
		color: `color-mix(in oklch, ${base} 72%, hsl(var(--foreground)))`,
		backgroundColor: `color-mix(in srgb, ${base} 14%, transparent)`
	};
};
//#endregion
export { chipStyle };

//# sourceMappingURL=chipStyle.js.map