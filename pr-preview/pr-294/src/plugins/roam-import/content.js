//#region src/plugins/roam-import/content.ts
var ROAM_UID = "[A-Za-z0-9_-]+";
var ROAM_EMBED_DIRECTIVE = "(?:embed|\\[\\[embed\\]\\])";
var ROAM_EMBED_PATH_DIRECTIVE = "(?:embed-path|\\[\\[embed-path\\]\\])";
var EMBED_RE = new RegExp(`\\{\\{\\s*${ROAM_EMBED_DIRECTIVE}\\s*:{1,2}\\s*\\(\\((${ROAM_UID})\\)\\)\\s*\\}\\}`, "g");
var EMBED_PATH_RE = new RegExp(`\\{\\{\\s*${ROAM_EMBED_PATH_DIRECTIVE}\\s*:{1,2}\\s*\\(\\((${ROAM_UID})\\)\\)\\s*\\}\\}`, "g");
var ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]]+)\\]\\(\\(\\((${ROAM_UID})\\)\\)\\)`, "g");
var BLOCK_REF_RE = new RegExp(`\\(\\((${ROAM_UID})\\)\\)`, "g");
var HASH_PAGE_RE = /(^|[^\w/:])#\[\[([^\]]+)\]\]/g;
var HASH_TAG_RE = /(^|[^\w/:])#([\w/-]+)/g;
var URL_RE = /https?:\/\/[^\s<>)\]]+/g;
var collectContentRefUids = (content) => {
	const out = /* @__PURE__ */ new Set();
	const protectedRanges = collectCodeRanges(content);
	const matchAllAt = (re, captureIndex) => {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(content)) !== null) {
			if (isProtected(protectedRanges, m.index, m.index + m[0].length)) continue;
			out.add(m[captureIndex]);
		}
	};
	matchAllAt(EMBED_PATH_RE, 1);
	matchAllAt(EMBED_RE, 1);
	matchAllAt(ALIASED_BLOCK_REF_RE, 2);
	matchAllAt(BLOCK_REF_RE, 1);
	return [...out];
};
var collectBlockRefRewrites = (raw, resolve) => {
	const found = [];
	const consumed = [];
	const protectedRanges = collectCodeRanges(raw);
	const overlapsConsumed = (start, end) => consumed.some(([s, e]) => start < e && end > s);
	const collect = (re, makeMatch) => {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(raw)) !== null) {
			const match = makeMatch(m);
			if (isProtected(protectedRanges, match.start, match.end)) continue;
			if (overlapsConsumed(match.start, match.end)) continue;
			found.push(match);
			consumed.push([match.start, match.end]);
		}
	};
	collect(EMBED_PATH_RE, (m) => {
		const target = resolve(m[1]);
		return {
			start: m.index,
			end: m.index + m[0].length,
			replacement: `!((${target}))`,
			embedPathTarget: target
		};
	});
	collect(EMBED_RE, (m) => ({
		start: m.index,
		end: m.index + m[0].length,
		replacement: `!((${resolve(m[1])}))`
	}));
	collect(ALIASED_BLOCK_REF_RE, (m) => ({
		start: m.index,
		end: m.index + m[0].length,
		replacement: `[${m[1]}](((${resolve(m[2])})))`
	}));
	collect(BLOCK_REF_RE, (m) => ({
		start: m.index,
		end: m.index + m[0].length,
		replacement: `((${resolve(m[1])}))`
	}));
	return found.sort((a, b) => a.start - b.start);
};
var rangeContains = (range, index) => index >= range.start && index < range.end;
var rangeOverlaps = (range, start, end) => start < range.end && end > range.start;
var isProtected = (ranges, start, end) => ranges.some((range) => rangeContains(range, start) || rangeOverlaps(range, start, end));
var findClosingParen = (value, start) => {
	let depth = 1;
	for (let i = start; i < value.length; i++) {
		const ch = value[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "(") {
			depth += 1;
			continue;
		}
		if (ch === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};
var collectMarkdownLinkRanges = (content) => {
	const ranges = [];
	for (let i = 0; i < content.length - 1; i++) {
		if (content[i] !== "]" || content[i + 1] !== "(") continue;
		let labelStart = i - 1;
		while (labelStart >= 0) {
			if (content[labelStart] === "\\") {
				labelStart -= 2;
				continue;
			}
			if (content[labelStart] === "[") break;
			labelStart -= 1;
		}
		if (labelStart < 0) continue;
		const destinationStart = i + 2;
		const destinationEnd = findClosingParen(content, destinationStart);
		if (destinationEnd < 0) continue;
		ranges.push({
			start: labelStart,
			end: i + 1
		});
		ranges.push({
			start: destinationStart,
			end: destinationEnd
		});
		i = destinationEnd;
	}
	return ranges;
};
var collectCodeRanges = (content) => {
	const ranges = [];
	let i = 0;
	while (i < content.length) {
		if (content.startsWith("```", i)) {
			const end = content.indexOf("```", i + 3);
			const rangeEnd = end < 0 ? content.length : end + 3;
			ranges.push({
				start: i,
				end: rangeEnd
			});
			i = rangeEnd;
			continue;
		}
		if (content[i] === "`") {
			const end = content.indexOf("`", i + 1);
			if (end < 0) break;
			ranges.push({
				start: i,
				end: end + 1
			});
			i = end + 1;
			continue;
		}
		i += 1;
	}
	return ranges;
};
var collectPageRefRanges = (content) => {
	const ranges = [];
	const stack = [];
	let i = 0;
	while (i < content.length - 1) {
		const token = content.slice(i, i + 2);
		if (token === "[[") {
			if (content[i - 1] !== "#") stack.push(i);
			i += 2;
			continue;
		}
		if (token === "]]") {
			if (stack.length > 0) {
				const start = stack.pop();
				if (stack.length === 0) ranges.push({
					start,
					end: i + 2
				});
			}
			i += 2;
			continue;
		}
		i += 1;
	}
	return ranges;
};
var collectUrlRanges = (content) => {
	const ranges = [];
	URL_RE.lastIndex = 0;
	let match;
	while ((match = URL_RE.exec(content)) !== null) ranges.push({
		start: match.index,
		end: match.index + match[0].length
	});
	return ranges;
};
var collectHashRewriteProtectedRanges = (content) => [
	...collectCodeRanges(content),
	...collectMarkdownLinkRanges(content),
	...collectPageRefRanges(content),
	...collectUrlRanges(content)
].sort((a, b) => a.start - b.start || a.end - b.end);
var rewriteHashPages = (content, protectedRanges) => content.replace(HASH_PAGE_RE, (match, lead, label, offset) => {
	return isProtected(protectedRanges, offset + lead.length, offset + match.length) ? match : `${lead}[[${label}]]`;
});
var rewriteHashTags = (content, protectedRanges) => content.replace(HASH_TAG_RE, (match, lead, label, offset) => {
	return isProtected(protectedRanges, offset + lead.length, offset + match.length) ? match : `${lead}[[${label}]]`;
});
var rewriteRoamHashtags = (content) => {
	const protectedRanges = collectHashRewriteProtectedRanges(content);
	return rewriteHashTags(rewriteHashPages(content, protectedRanges), protectedRanges);
};
var rewriteRoamContent = (raw, uidMap) => {
	const unresolved = /* @__PURE__ */ new Set();
	const resolve = (roamUid) => {
		const ourId = uidMap.get(roamUid);
		if (ourId) return ourId;
		unresolved.add(roamUid);
		return roamUid;
	};
	const rewrites = collectBlockRefRewrites(raw, resolve);
	const embedPathTargets = rewrites.map((r) => r.embedPathTarget).filter((target) => Boolean(target));
	let out = "";
	let cursor = 0;
	for (const r of rewrites) {
		out += raw.slice(cursor, r.start) + r.replacement;
		cursor = r.end;
	}
	out += raw.slice(cursor);
	out = rewriteRoamHashtags(out);
	return {
		content: out,
		unresolvedBlockUids: [...unresolved],
		embedPathTargets
	};
};
var applyHeading = (content, heading) => {
	if (!heading || heading <= 0) return content;
	const safe = Math.min(heading, 6);
	return `${"#".repeat(safe) + " "}${content}`;
};
//#endregion
export { applyHeading, collectContentRefUids, rewriteRoamContent, rewriteRoamHashtags };

//# sourceMappingURL=content.js.map