//#region src/utils/fuzzyRank.ts
/**
* Shared fuzzy + recency ranker for page completion and Quick Find.
*
* Pipeline (caller-side): pre-filter candidates with a permissive SQL
* LIKE (typically the prefix-3 of each query token, ANDed), then pass
* the candidate rows through `rankCandidates` for the final ordering
* and filtering.
*
* Matching: a candidate matches when every query token has either a
* literal substring match (case-insensitive) or — for tokens of length
* >= 4 — a substring at edit distance 1. Each token contributes its
* own score (word-start beats substring beats typo); whole-query
* exact / prefix / substring matches add a large bonus on top so the
* "I typed exactly the page name" path stays at the top regardless of
* recency. Recency is layered last (MRU > recent edit > nothing).
*/
var PREFIX_FILTER_LEN = 3;
var TYPO_MIN_TOKEN_LEN = 4;
var SCORE_FULL_EXACT = 1e3;
var SCORE_FULL_PREFIX = 500;
var SCORE_FULL_SUBSTRING = 200;
var SCORE_TOKEN_WORD_START = 30;
var SCORE_TOKEN_SUBSTRING = 15;
var SCORE_TOKEN_TYPO = 4;
var SCORE_RECENT_MRU_HEAD = 80;
var SCORE_RECENT_MRU_STEP = 6;
var SCORE_RECENT_EDIT_HOUR = 25;
var SCORE_RECENT_EDIT_DAY = 14;
var SCORE_RECENT_EDIT_WEEK = 6;
var HOUR_MS = 3600 * 1e3;
var DAY_MS = 24 * HOUR_MS;
var WEEK_MS = 7 * DAY_MS;
/** Split a query into lowercased tokens by whitespace. */
var tokenize = (query) => query.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
/**
* Build a LIKE pattern set for SQL pre-filtering. Each token is reduced
* to its first {@link PREFIX_FILTER_LEN} characters (or its full length
* if shorter) — enough to discriminate but permissive enough to survive
* a single-edit typo anywhere after the third character.
*/
var buildFilterPrefixes = (query) => {
	const tokens = tokenize(query);
	const seen = /* @__PURE__ */ new Set();
	const prefixes = [];
	for (const token of tokens) {
		const prefix = token.slice(0, PREFIX_FILTER_LEN);
		if (seen.has(prefix)) continue;
		seen.add(prefix);
		prefixes.push(prefix);
	}
	return prefixes;
};
var editDistanceAtMostOne = (a, b) => {
	if (a === b) return true;
	const diff = a.length - b.length;
	if (diff > 1 || diff < -1) return false;
	if (a.length === b.length) {
		let mismatches = 0;
		for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) {
			mismatches++;
			if (mismatches > 1) return false;
		}
		return true;
	}
	const shorter = a.length < b.length ? a : b;
	const longer = a.length < b.length ? b : a;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < shorter.length && j < longer.length) if (shorter.charCodeAt(i) === longer.charCodeAt(j)) {
		i++;
		j++;
	} else {
		edits++;
		if (edits > 1) return false;
		j++;
	}
	return true;
};
var hasTypoSubstring = (text, token) => {
	if (token.length < TYPO_MIN_TOKEN_LEN) return false;
	for (let i = 0; i <= text.length; i++) for (const delta of [
		-1,
		0,
		1
	]) {
		const subLen = token.length + delta;
		if (subLen <= 0 || i + subLen > text.length) continue;
		if (editDistanceAtMostOne(text.slice(i, i + subLen), token)) return true;
	}
	return false;
};
/** Returns the score for a single token against a lowercased candidate
*  string, or `null` if the token does not match at all. */
var scoreToken = (lowerText, token) => {
	const idx = lowerText.indexOf(token);
	if (idx === 0) return SCORE_TOKEN_WORD_START;
	if (idx > 0) {
		const prev = lowerText.charCodeAt(idx - 1);
		return !(prev >= 97 && prev <= 122 || prev >= 48 && prev <= 57) ? SCORE_TOKEN_WORD_START : SCORE_TOKEN_SUBSTRING;
	}
	if (hasTypoSubstring(lowerText, token)) return SCORE_TOKEN_TYPO;
	return null;
};
var recencyBoost = (blockId, updatedAt, recentBlockIds, now) => {
	let boost = 0;
	if (recentBlockIds) {
		const idx = recentBlockIds.indexOf(blockId);
		if (idx >= 0) {
			const decayed = SCORE_RECENT_MRU_HEAD - idx * SCORE_RECENT_MRU_STEP;
			boost += Math.max(decayed, 0);
		}
	}
	if (typeof updatedAt === "number") {
		const age = now - updatedAt;
		if (age <= HOUR_MS) boost += SCORE_RECENT_EDIT_HOUR;
		else if (age <= DAY_MS) boost += SCORE_RECENT_EDIT_DAY;
		else if (age <= WEEK_MS) boost += SCORE_RECENT_EDIT_WEEK;
	}
	return boost;
};
/**
* Score a single candidate label against a query. Returns `null` when
* the candidate doesn't satisfy every query token. Exported so callers
* that already have everything (e.g. content snippets) can use it
* outside the {@link rankCandidates} pipeline.
*/
var scoreCandidate = (label, query, queryTokens) => {
	if (queryTokens.length === 0) return 0;
	const lowerLabel = label.toLowerCase();
	const lowerQuery = query.toLowerCase().trim();
	let tokenScore = 0;
	for (const token of queryTokens) {
		const ts = scoreToken(lowerLabel, token);
		if (ts === null) return null;
		tokenScore += ts;
	}
	let bonus = 0;
	if (lowerQuery.length > 0) {
		if (lowerLabel === lowerQuery) bonus = SCORE_FULL_EXACT;
		else if (lowerLabel.startsWith(lowerQuery)) bonus = SCORE_FULL_PREFIX;
		else if (lowerLabel.includes(lowerQuery)) bonus = SCORE_FULL_SUBSTRING;
	}
	return tokenScore + bonus;
};
/**
* Rank a candidate set against the query, dropping non-matches and
* sorting by score descending. Ties break on shorter label first, then
* locale-alphabetical (so the output is deterministic).
*/
var rankCandidates = ({ candidates, query, recentBlockIds, now = Date.now() }) => {
	const tokens = tokenize(query);
	const out = [];
	if (tokens.length === 0) for (const candidate of candidates) out.push({
		candidate,
		score: recencyBoost(candidate.blockId, candidate.updatedAt, recentBlockIds, now)
	});
	else for (const candidate of candidates) {
		const matchScore = scoreCandidate(candidate.label, query, tokens);
		if (matchScore === null) continue;
		const boost = recencyBoost(candidate.blockId, candidate.updatedAt, recentBlockIds, now);
		out.push({
			candidate,
			score: matchScore + boost
		});
	}
	out.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const la = a.candidate.label.length;
		const lb = b.candidate.label.length;
		if (la !== lb) return la - lb;
		return a.candidate.label.localeCompare(b.candidate.label);
	});
	return out;
};
//#endregion
export { buildFilterPrefixes, rankCandidates, scoreCandidate, tokenize };

//# sourceMappingURL=fuzzyRank.js.map