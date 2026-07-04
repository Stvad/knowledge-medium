//#region src/shortcuts/canonicalizeChord.ts
/** Stable modifier order, so the same physical chord always serialises
*  identically. `$mod` first, then the literal modifiers. */
var MODIFIER_ORDER = [
	"$mod",
	"Control",
	"Alt",
	"Shift"
];
/** Fold the assorted spellings of each modifier onto one canonical name. */
var MODIFIER_ALIASES = {
	cmd: "$mod",
	meta: "$mod",
	os: "$mod",
	"$mod": "$mod",
	ctrl: "Control",
	control: "Control",
	option: "Alt",
	alt: "Alt",
	shift: "Shift"
};
/** Parse a single press ('Cmd+Shift+K') into ordered, alias-folded
*  modifiers plus the final key (case preserved). Modifier tokens in any
*  position fold to a modifier; the remaining token is the key. */
var parsePress = (press) => {
	const tokens = press.split("+").map((t) => t.trim()).filter(Boolean);
	const mods = [];
	let key = "";
	for (const token of tokens) {
		const alias = MODIFIER_ALIASES[token.toLowerCase()];
		if (alias) mods.push(alias);
		else key = token;
	}
	return {
		mods: MODIFIER_ORDER.filter((m) => mods.includes(m)),
		key
	};
};
/** Split a chord into its presses. A chord is space-separated presses
*  ('g g'); ordinary chords yield a single press. */
var splitSequence = (raw) => raw.split(" ").map((p) => p.trim()).filter(Boolean);
/** Serialise a parsed press back to its canonical chord string. */
var formatPress = ({ mods, key }) => [...mods, key].filter(Boolean).join("+");
/**
* Canonicalise a single press — stable modifier ordering, alias folding
* (`cmd` → `$mod`, `Option` → `Alt`, …). Used to detect equivalence when
* checking for duplicates ('Meta+K' and '$mod+k' match on a Mac-style
* binding, where Meta is the primary).
*
* Kept single-press (splits on `+` only) for the settings UI, which
* re-exports it via `keyCapture.ts` and feeds it one press at a time. For
* sequence-aware canonicalisation use `canonicalizeChord`.
*/
var normalizeChord = (chord) => formatPress(parsePress(chord));
/**
* Canonicalise a whole chord, sequence-aware: splits on space first, then
* canonicalises each press, so 'Cmd+K Cmd+S' becomes '$mod+k $mod+s'
* instead of being mangled by a naive `+` split. Returns a stable string
* key for bucketing/dedup. When `phase` is supplied it is folded into the
* key, so the same chord on different phases (hold `s` vs keyup `s`) does
* not collapse together.
*/
var canonicalizeChord = (raw, phase) => {
	const canonical = splitSequence(raw).map((press) => formatPress(parsePress(press))).join(" ");
	return phase ? `${phase}:${canonical}` : canonical;
};
/**
* Parse a chord into an ordered sequence of descriptors for matching.
* Splits on space first, so 'd d' / 'g g' become two presses instead of
* one atomic key — the historical cause of dead sequence chords. Plain
* chords yield a length-1 sequence.
*/
var parseChord = (raw, phase = "keydown") => splitSequence(raw).map((press) => {
	const { mods, key } = parsePress(press);
	return {
		kind: "key",
		key,
		mods,
		phase
	};
});
/** Platform-primary detection for `$mod` (Cmd on Apple, Ctrl elsewhere),
*  mirroring tinykeys so keyboard and pointer agree on what `$mod` means. */
var platformPrimaryIsMeta = () => typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || "");
/** Expand a canonical modifier set to the four physical flags it requires,
*  resolving `$mod` to the platform-primary key. Exact-match semantics: a flag
*  not listed must be absent on the event. */
var requiredModifierFlags = (mods) => {
	const primaryIsMeta = platformPrimaryIsMeta();
	let shiftKey = false, altKey = false, ctrlKey = false, metaKey = false;
	for (const mod of mods) if (mod === "Shift") shiftKey = true;
	else if (mod === "Alt") altKey = true;
	else if (mod === "Control") ctrlKey = true;
	else if (mod === "$mod") if (primaryIsMeta) metaKey = true;
	else ctrlKey = true;
	return {
		shiftKey,
		altKey,
		ctrlKey,
		metaKey
	};
};
/** Realize a {@link PointerBindingSpec}'s declared/defaulted fields into the
*  descriptor the matcher and coordinator compare against. */
var pointerBindingDescriptor = (spec) => spec.kind === "touch" ? {
	kind: "touch",
	phase: spec.phase ?? "tap"
} : {
	kind: "mouse",
	button: spec.button ?? 0,
	detail: spec.detail ?? 1,
	mods: spec.mods ?? [],
	...spec.role !== void 0 ? { role: spec.role } : {},
	phase: spec.phase ?? "click"
};
/**
* Does a mouse event satisfy a {@link MouseChordDescriptor}? Button and click
* count match exactly, and the modifier set matches exactly — `mods: ['Shift']`
* requires Shift held and Ctrl/Alt/Meta absent, so shift-click (extend
* selection) and ctrl-click (toggle selection) never collide. `role` is the
* coordinator's concern (it constrains the bound node), so it isn't consulted
* here.
*/
var matchesMouseEvent = (descriptor, event) => {
	if (event.button !== descriptor.button) return false;
	if (event.detail !== descriptor.detail) return false;
	const required = requiredModifierFlags(descriptor.mods);
	return event.shiftKey === required.shiftKey && event.altKey === required.altKey && event.ctrlKey === required.ctrlKey && event.metaKey === required.metaKey;
};
//#endregion
export { canonicalizeChord, matchesMouseEvent, normalizeChord, parseChord, pointerBindingDescriptor };

//# sourceMappingURL=canonicalizeChord.js.map