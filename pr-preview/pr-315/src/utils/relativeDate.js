import { formatIsoDate, formatRoamDate } from "./dailyPage.js";
import { casual } from "../../node_modules/chrono-node/dist/esm/index.js";
//#region src/utils/relativeDate.ts
var PREFIX_MIN_LENGTH = 2;
var RELATIVE_DATE_PREFIXES = [{
	phrase: "today",
	offsetDays: 0
}, {
	phrase: "tomorrow",
	offsetDays: 1
}];
var localDateWithOffset = (now, offsetDays) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
var parseRelativeDate = (input, now = /* @__PURE__ */ new Date()) => {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const result = casual.parse(trimmed, now, { forwardDate: true })[0];
	if (!result) return null;
	if (result.text.length !== trimmed.length) return null;
	const date = result.start.date();
	const year = date.getFullYear();
	if (year < 1e3 || year > 9999) return null;
	return {
		iso: formatIsoDate(date),
		date
	};
};
/**
* Completion-oriented date candidates. Unlike `parseRelativeDate`, this
* accepts partial prefixes and may return multiple dates (`"to"` means
* both "today" and "tomorrow"). Keep this out of storage-time parsing:
* it is a query/autocomplete helper, not a statement that the input is a
* complete date expression.
*/
var relativeDateCandidates = (input, now = /* @__PURE__ */ new Date()) => {
	const trimmed = input.trim();
	const normalized = trimmed.toLowerCase();
	if (!normalized) return [];
	const candidates = [];
	const seenIso = /* @__PURE__ */ new Set();
	const add = (candidate) => {
		if (seenIso.has(candidate.iso)) return;
		seenIso.add(candidate.iso);
		candidates.push(candidate);
	};
	if (normalized.length >= PREFIX_MIN_LENGTH) for (const spec of RELATIVE_DATE_PREFIXES) {
		if (!spec.phrase.startsWith(normalized)) continue;
		const date = localDateWithOffset(now, spec.offsetDays);
		add({
			phrase: spec.phrase,
			iso: formatIsoDate(date),
			date
		});
	}
	const parsed = parseRelativeDate(trimmed, now);
	if (parsed) add({
		phrase: trimmed,
		...parsed
	});
	return candidates;
};
/**
* Strict variant of `parseRelativeDate` for storage-time decisions
* (currently: Roam import deciding which `[[wiki-link]]` aliases should
* be rewired to a daily-note id, and which Roam pages without a
* `:log/id` should be treated as dailies).
*
* Returns a parse result iff `input` is a *literal* daily-page title —
* either ISO ("2026-04-28") or the Roam long form ("April 28th, 2026").
* Relative-time keywords like "today" / "now" / "friday" / "may" /
* "noon" / "next week" are intentionally rejected here; those still
* resolve via `parseRelativeDate` for autocomplete + navigation, but
* must NOT collapse references to a calendar id at import time. (Roam
* itself doesn't do that — `[[today]]` is a regular page named
* "today", not an alias for the day's daily.) The earlier behavior
* pulled every historical `[[today]]` / `[[now]]` / `[[friday]]` into
* the *current* day's backlinks after a re-import.
*
* Implementation: parse via `parseRelativeDate`, then verify the input
* roundtrips through one of the two canonical formatters. Anything
* that chrono *could* parse (relative or fuzzy) but that isn't already
* in canonical form is rejected — including malformed-but-coercible
* literals like "2026-13-01" (chrono would happily reinterpret).
*/
var parseLiteralDailyPageTitle = (input, now = /* @__PURE__ */ new Date()) => {
	const parsed = parseRelativeDate(input, now);
	if (!parsed) return null;
	const trimmed = input.trim();
	if (trimmed === parsed.iso) return parsed;
	if (trimmed === formatRoamDate(parsed.date)) return parsed;
	return null;
};
//#endregion
export { parseLiteralDailyPageTitle, parseRelativeDate, relativeDateCandidates };

//# sourceMappingURL=relativeDate.js.map