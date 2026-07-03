//#region src/editor/triggerMatch.ts
/** All registered trigger chars. The walk breaks on a SIBLING trigger
*  so the nearest trigger owns the input: in `meet @cafe #todo|` the
*  `#` source matches `todo` while the `@` walk hits the `#` and
*  yields — otherwise both sources fire into one dropdown, the place
*  query swallows ` #todo` (a remote Places request per keystroke),
*  and the type query swallows ` @home`. */
var TRIGGER_CHARS = new Set(["@", "#"]);
/** Queries routinely span words, so the caps below decide when a
*  trigger earlier in the line stops owning what the user types: a
*  double space or any non-space whitespace ends the query
*  immediately, and a query longer than this many chars/words is
*  prose, not a name. Without the caps, every sentence containing a
*  bare `@word` would re-open the dropdown on each keystroke until end
*  of line. */
var MAX_QUERY_LEN = 50;
var MAX_QUERY_WORDS = 6;
/** True when `beforePos` sits after an unclosed `[[` — wikilink spans
*  belong to the wikilink autocomplete, so char triggers inside them
*  must not fire. */
var isInsideUnclosedWikilink = (text, beforePos) => {
	let opens = 0;
	let closes = 0;
	for (let i = 0; i < beforePos - 1; i++) if (text[i] === "[" && text[i + 1] === "[") {
		opens += 1;
		i += 1;
	} else if (text[i] === "]" && text[i + 1] === "]") {
		closes += 1;
		i += 1;
	}
	return opens > closes;
};
/** Pure trigger-detection helper. Callers export thin per-char
*  wrappers (`matchAtTrigger`, `matchHashTrigger`) for their
*  CompletionSources and tests. */
var matchCharTrigger = (text, pos, trigger, opts = {}) => {
	if (!TRIGGER_CHARS.has(trigger)) throw new Error(`matchCharTrigger: trigger '${trigger}' is not registered in TRIGGER_CHARS`);
	let i = pos;
	while (i > 0) {
		const c = text[i - 1];
		if (c === trigger) break;
		if (TRIGGER_CHARS.has(c) && !(i >= 2 && /\w/.test(text[i - 2]))) return null;
		if (c === " ") {
			if (i >= 2 && text[i - 2] === " ") return null;
		} else if (/\s/.test(c)) return null;
		if (c === "[" || c === "]") return null;
		if (pos - i >= MAX_QUERY_LEN) return null;
		i -= 1;
	}
	if (i === 0 || text[i - 1] !== trigger) return null;
	const query = text.slice(i, pos);
	if (query.startsWith(" ")) return null;
	if (query.split(" ").filter((w) => w.length > 0).length > MAX_QUERY_WORDS) return null;
	const triggerPos = i - 1;
	if (triggerPos > 0 && /\w/.test(text[triggerPos - 1])) return null;
	if (opts.rejectDoubledTrigger && triggerPos > 0 && text[triggerPos - 1] === trigger) return null;
	if (triggerPos > 0 && text[triggerPos - 1] === "[") return null;
	if (isInsideUnclosedWikilink(text, triggerPos)) return null;
	if (/\(\([^)]*$/.test(text.slice(0, triggerPos))) return null;
	return {
		from: triggerPos,
		query
	};
};
//#endregion
export { matchCharTrigger };

//# sourceMappingURL=triggerMatch.js.map