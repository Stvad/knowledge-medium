import { DAILY_NOTE_TYPE } from "../daily-notes/schema.js";
import { parseOutermostReferences, parseReferences } from "../references/referenceParser.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import { rewriteRoamHashtags } from "./content.js";
//#region src/plugins/roam-import/properties.ts
var NS_PREFIX = "roam";
var ROAM_PAGE_ALIAS_PROP = `${NS_PREFIX}:page_alias`;
var ROAM_AUTHOR_PROP = `${NS_PREFIX}:author`;
var ROAM_ISA_PROP = `${NS_PREFIX}:isa`;
var ROAM_EMBED_PATH_PROP = `${NS_PREFIX}:embed-path`;
var ROAM_URL_PROP = `${NS_PREFIX}:URL`;
var ROAM_TIMESTAMP_PROP = `${NS_PREFIX}:timestamp`;
var ROAM_MESSAGE_URL_PROP = `${NS_PREFIX}:message-url`;
var ROAM_MESSAGE_AUTHOR_PROP = `${NS_PREFIX}:message-author`;
var ROAM_MESSAGE_TIMESTAMP_PROP = `${NS_PREFIX}:message-timestamp`;
var isRoamSemanticRefListProperty = (name) => name === ROAM_ISA_PROP || name === ROAM_PAGE_ALIAS_PROP;
/** Given the per-property token tally, return the `targetTypes` to use
*  when registering the property's refList schema. Conservative — only
*  emits a result when every observed token unanimously fits a known
*  target type, so users with mixed-target Roam properties land on an
*  un-constrained refList that they can refine via RefTargetTypePicker. */
var inferRefListTargetTypes = (tally) => {
	if (tally.total === 0) return void 0;
	if (tally.total === tally.dailyNote) return [DAILY_NOTE_TYPE];
};
/** True iff `alias` is a canonical daily-note page title (ISO or
*  Roam-style) — i.e. the import will resolve it to a daily-note block. */
var isDailyNoteAlias = (alias) => parseLiteralDailyPageTitle(alias) !== null;
var uniqueExactStrings = (values) => {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of values) {
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
};
var namespacedKey = (key) => {
	return `${NS_PREFIX}:${key.startsWith(":") ? key.slice(1) : key}`;
};
var findUnescaped = (value, target, start) => {
	for (let i = start; i < value.length; i++) {
		if (value[i] === "\\") {
			i += 1;
			continue;
		}
		if (value[i] === target) return i;
	}
	return -1;
};
var findMarkdownLinkDestinationEnd = (value, start) => {
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
/** If a Roam property value is exactly one markdown link, store the
*  destination as the queryable value while leaving the original
*  source block's content untouched in the imported tree. */
var normalizeRoamPropertyValue = (value) => {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[")) return value;
	const labelEnd = findUnescaped(trimmed, "]", 1);
	if (labelEnd < 0 || trimmed[labelEnd + 1] !== "(") return value;
	const destinationStart = labelEnd + 2;
	const destinationEnd = findMarkdownLinkDestinationEnd(trimmed, destinationStart);
	if (destinationEnd < 0 || destinationEnd !== trimmed.length - 1) return value;
	const destination = trimmed.slice(destinationStart, destinationEnd).trim();
	return destination === "" ? value : destination;
};
var parseLeadingMarkdownLink = (value) => {
	const trimmedStart = value.match(/^\s*/)?.[0].length ?? 0;
	if (value[trimmedStart] !== "[") return null;
	const labelEnd = findUnescaped(value, "]", trimmedStart + 1);
	if (labelEnd < 0 || value[labelEnd + 1] !== "(") return null;
	const destinationStart = labelEnd + 2;
	const destinationEnd = findMarkdownLinkDestinationEnd(value, destinationStart);
	if (destinationEnd < 0) return null;
	return {
		label: value.slice(trimmedStart + 1, labelEnd).trim(),
		destination: value.slice(destinationStart, destinationEnd).trim(),
		end: destinationEnd + 1
	};
};
var pageTokenFromReference = (ref) => ({
	alias: ref.alias,
	start: ref.startIndex,
	end: ref.endIndex
});
var outerPageTokens = (value) => parseOutermostReferences(value).map(pageTokenFromReference);
var allPageTokens = (value) => parseReferences(value).map(pageTokenFromReference);
var isPageTokenListValue = (value, tokens) => {
	if (tokens.length === 0) return false;
	let cursor = 0;
	for (const token of tokens) {
		if (!/^[\s,;]*$/.test(value.slice(cursor, token.start))) return false;
		cursor = token.end;
	}
	return /^[\s,;]*$/.test(value.slice(cursor));
};
var explodePageTokens = (value) => {
	const tokens = parsePageTokenList(value);
	if (!tokens) return null;
	const out = tokens.map((token) => `[[${token.alias}]]`);
	if (out.length < 2) return null;
	return out;
};
var parsePageTokenList = (value) => {
	const tokens = outerPageTokens(value);
	return isPageTokenListValue(value, tokens) ? tokens : null;
};
var collectAliasesFromPropertyValues = (promoted) => {
	const out = /* @__PURE__ */ new Set();
	const visit = (v) => {
		if (typeof v === "string") for (const token of allPageTokens(v)) out.add(token.alias);
		else if (Array.isArray(v)) for (const item of v) visit(item);
	};
	for (const [name, v] of Object.entries(promoted)) {
		if (isRoamSemanticRefListProperty(name)) continue;
		visit(v);
	}
	return [...out];
};
var looksSerializedJson = (value) => value.startsWith("{") && value.endsWith("}") || value.startsWith("[") && value.endsWith("]") && !value.startsWith("[[");
var parseQuotedAliasListValue = (value) => {
	const out = [];
	let i = 0;
	const skipSpace = () => {
		while (i < value.length && /\s/.test(value[i])) i += 1;
	};
	while (i < value.length) {
		skipSpace();
		if (i >= value.length) break;
		const quote = value[i];
		if (quote !== "\"" && quote !== "'") return null;
		i += 1;
		let alias = "";
		let closed = false;
		while (i < value.length) {
			const ch = value[i];
			if (ch === "\\" && i + 1 < value.length) {
				alias += value[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) {
				closed = true;
				i += 1;
				break;
			}
			alias += ch;
			i += 1;
		}
		if (!closed) return null;
		if (alias === "") return null;
		out.push(alias);
		skipSpace();
		if (i >= value.length) break;
		if (value[i] !== ",") return null;
		i += 1;
	}
	return out.length > 0 ? uniqueExactStrings(out) : null;
};
var isConservativePlainAlias = (value) => {
	if (!value) return false;
	if (looksSerializedJson(value)) return false;
	if (value.startsWith("#")) return false;
	if ([
		"{",
		"}",
		"[",
		"]",
		"*",
		",",
		";",
		":"
	].some((ch) => value.includes(ch))) return false;
	if (/https?:\/\//i.test(value)) return false;
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length === 0 || words.length > 4) return false;
	const hasNonAscii = Array.from(value).some((ch) => ch.codePointAt(0) > 127);
	return /[A-Z0-9@]/.test(value) || hasNonAscii || words.length === 1;
};
var collectAliasesFromRoamSemanticRefListValue = (value, plainAliasMode = "broad") => {
	if (Array.isArray(value)) return uniqueExactStrings(value.flatMap((item) => collectAliasesFromRoamSemanticRefListValue(item, plainAliasMode)));
	if (typeof value !== "string") return [];
	const trimmed = rewriteSemanticRefListValue(value);
	if (!trimmed) return [];
	const tokens = parsePageTokenList(trimmed);
	if (tokens) return uniqueExactStrings(tokens.map((token) => token.alias));
	if (parseReferences(trimmed).length > 0) return [];
	const quotedAliases = parseQuotedAliasListValue(trimmed);
	if (quotedAliases) return quotedAliases;
	if (plainAliasMode === "conservative") return isConservativePlainAlias(trimmed) ? [trimmed] : [];
	return looksSerializedJson(trimmed) ? [] : [trimmed];
};
var rewriteSemanticRefListValue = (value) => {
	const trimmed = value.trim();
	if (!trimmed.includes("#")) return trimmed;
	if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return trimmed;
	if (looksSerializedJson(trimmed)) return trimmed;
	return rewriteRoamHashtags(trimmed);
};
var collectAliasesFromRoamSemanticRefListProperties = (properties) => uniqueExactStrings(Object.entries(properties).filter(([name]) => isRoamSemanticRefListProperty(name)).flatMap(([name, value]) => collectReferencedAliasesFromRoamSemanticRefListValue(value, name === ROAM_PAGE_ALIAS_PROP ? "conservative" : "broad")));
var collectReferencedAliasesFromRoamSemanticRefListValue = (value, plainAliasMode) => {
	if (Array.isArray(value)) return uniqueExactStrings(value.flatMap((item) => collectReferencedAliasesFromRoamSemanticRefListValue(item, plainAliasMode)));
	if (typeof value !== "string") return [];
	const trimmed = rewriteSemanticRefListValue(value);
	if (!trimmed) return [];
	if (parsePageTokenList(trimmed)) return uniqueExactStrings(parseReferences(trimmed).map((ref) => ref.alias));
	if (parseReferences(trimmed).length > 0) return [];
	const quotedAliases = parseQuotedAliasListValue(trimmed);
	if (quotedAliases) return quotedAliases;
	if (plainAliasMode === "conservative") return isConservativePlainAlias(trimmed) ? [trimmed] : [];
	return looksSerializedJson(trimmed) ? [] : [trimmed];
};
/** Translate Roam's property bag into the new flat-property shape:
*  values are stored encoded directly under their (namespaced) key.
*  Numbers stay numbers, strings stay strings, structured values are
*  JSON-stringified for round-trip. The Roam namespace prefix
*  (`roam:`) keeps these from colliding with kernel properties. */
var propertiesFromRoam = (raw) => {
	const out = {};
	for (const [key, value] of Object.entries(raw)) {
		const propName = namespacedKey(key);
		if (typeof value === "number") out[propName] = value;
		else if (typeof value === "string") out[propName] = normalizeRoamPropertyValue(value);
		else if (value !== null && value !== void 0) out[propName] = JSON.stringify(value);
	}
	return out;
};
var collectStandardPageAliasValues = (value) => {
	const values = Array.isArray(value) ? value : [value];
	const out = [];
	for (const item of values) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed) continue;
		const tokens = parsePageTokenList(trimmed);
		if (!tokens) continue;
		out.push(...tokens.map((token) => token.alias));
	}
	return out;
};
var collectPageAliases = (properties) => uniqueExactStrings(collectStandardPageAliasValues(properties[ROAM_PAGE_ALIAS_PROP]));
var nonStandardPageAliasValues = (properties) => {
	const value = properties[ROAM_PAGE_ALIAS_PROP];
	const values = Array.isArray(value) ? value : [value];
	const out = [];
	for (const item of values) {
		if (item === void 0 || item === null) continue;
		if (typeof item !== "string") {
			out.push(JSON.stringify(item));
			continue;
		}
		const trimmed = item.trim();
		if (!trimmed) continue;
		if (!parsePageTokenList(trimmed)) out.push(trimmed);
	}
	return out;
};
var READWISE_READ_URL_RE = /^https:\/\/read\.readwise\.io\/read\/[^\s<>)\]]+/i;
var URL_RE = /https?:\/\/[^\s<>)\]]+/i;
var parseLeadingPageRef = (value) => outerPageTokens(value).find((token) => /^\s*$/.test(value.slice(0, token.start))) ?? null;
var parseLeadingTitle = (value) => {
	const pageRef = parseLeadingPageRef(value);
	if (pageRef) {
		if (value.slice(pageRef.end).startsWith("(")) {
			const destinationEnd = findMarkdownLinkDestinationEnd(value, pageRef.end + 1);
			if (destinationEnd > 0) return {
				kind: "wiki",
				label: pageRef.alias,
				start: pageRef.start,
				end: destinationEnd + 1,
				destination: value.slice(pageRef.end + 1, destinationEnd).trim()
			};
		}
		return {
			kind: "wiki",
			label: pageRef.alias,
			start: pageRef.start,
			end: pageRef.end
		};
	}
	const markdown = parseLeadingMarkdownLink(value);
	if (!markdown) return null;
	return {
		kind: "markdown",
		label: markdown.label,
		start: value.match(/^\s*/)?.[0].length ?? 0,
		end: markdown.end,
		destination: markdown.destination
	};
};
var readwiseUrlFromDestination = (destination) => {
	if (!destination) return void 0;
	return READWISE_READ_URL_RE.exec(destination.trim())?.[0];
};
var firstUrl = (value) => URL_RE.exec(value)?.[0];
var authorPageRef = (value) => {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (!trimmed || trimmed === "[[]]") return void 0;
	const refs = parseReferences(trimmed);
	if (refs.length === 1 && refs[0].startIndex === 0 && refs[0].endIndex === trimmed.length) return `[[${refs[0].alias}]]`;
	if (refs.length > 0) return void 0;
	return `[[${trimmed}]]`;
};
var exactAuthorRefs = (value) => {
	const tokens = parsePageTokenList(value);
	if (!tokens) return null;
	return tokens.map((token) => token.alias).filter((alias) => alias !== "").map((alias) => `[[${alias}]]`);
};
var pushUrl = (urls, value) => {
	if (!value) return;
	const trimmed = value.trim();
	if (trimmed && !urls.includes(trimmed)) urls.push(trimmed);
};
var setUrlProperties = (properties, urls) => {
	if (urls.length === 0) return;
	properties[ROAM_URL_PROP] = urls.length === 1 ? urls[0] : [...urls];
};
var docAliasFromMarkdownLabel = (label) => {
	const cleaned = label.replace(/\s+/g, " ").trim();
	return cleaned.startsWith("doc/") ? cleaned : `doc/${cleaned}`;
};
var restAfterBy = (content, titleEnd) => {
	const match = /^\s+by\s+/i.exec(content.slice(titleEnd));
	if (!match) return null;
	return { rest: content.slice(titleEnd + match[0].length) };
};
var parseAuthorBeforeMarker = (rest, markerRe) => {
	markerRe.lastIndex = 0;
	const match = markerRe.exec(rest);
	if (!match) return null;
	return {
		author: rest.slice(0, match.index).replace(/\s+/g, " ").replace(/\s*[•·]\s*$/u, "").trim(),
		marker: match[0],
		afterMarker: rest.slice(match.index + match[0].length)
	};
};
var derivePropertiesFromContent = (content) => {
	const properties = {};
	const diagnostics = [];
	const title = parseLeadingTitle(content);
	if (!title) return {
		content,
		properties,
		diagnostics
	};
	const by = restAfterBy(content, title.end);
	if (!by) return {
		content,
		properties,
		diagnostics
	};
	const urls = [];
	const markdownReadwiseUrl = readwiseUrlFromDestination(title.destination);
	pushUrl(urls, markdownReadwiseUrl);
	const exactAuthors = exactAuthorRefs(by.rest.trim());
	if (exactAuthors) {
		if (exactAuthors.length === 1) properties[ROAM_AUTHOR_PROP] = exactAuthors[0];
		else if (title.label.startsWith("doc/")) diagnostics.push(`Readwise author candidate on [[${title.label}]] has ${exactAuthors.length} exact author refs; left roam:author unset.`);
		return {
			content,
			properties,
			diagnostics
		};
	}
	if (by.rest.trim() === "[[]]" && title.label.startsWith("doc/")) {
		diagnostics.push(`Readwise author candidate on [[${title.label}]] had blank [[]] author; left roam:author unset.`);
		return {
			content,
			properties,
			diagnostics
		};
	}
	const urlMarker = parseAuthorBeforeMarker(by.rest, /(?:^|\s)url:\s*/i);
	if (urlMarker) {
		const author = authorPageRef(urlMarker.author);
		if (author) properties[ROAM_AUTHOR_PROP] = author;
		else diagnostics.push(`Readwise author candidate on [[${title.label}]] had blank author before url:.`);
		pushUrl(urls, firstUrl(urlMarker.afterMarker));
		const viaMarker = parseAuthorBeforeMarker(urlMarker.afterMarker, /(?:^|\s)via\s+/i);
		pushUrl(urls, viaMarker ? firstUrl(viaMarker.afterMarker) : void 0);
		setUrlProperties(properties, urls);
		return {
			content,
			properties,
			diagnostics
		};
	}
	const viaMarker = parseAuthorBeforeMarker(by.rest, /(?:^|\s)via\s+/i);
	if (viaMarker && (markdownReadwiseUrl || title.destination?.includes("read.readwise.io/read"))) {
		const author = authorPageRef(viaMarker.author);
		if (author) properties[ROAM_AUTHOR_PROP] = author;
		else diagnostics.push(`Readwise author candidate on [[${title.label}]] had blank author before via.`);
		pushUrl(urls, firstUrl(viaMarker.afterMarker));
		setUrlProperties(properties, urls);
		if (title.kind === "markdown" && markdownReadwiseUrl) {
			const docAlias = docAliasFromMarkdownLabel(title.label);
			return {
				content: `${content.slice(0, title.start)}[[${docAlias}]]${content.slice(title.end)}`,
				properties,
				diagnostics
			};
		}
		return {
			content,
			properties,
			diagnostics
		};
	}
	return {
		content,
		properties,
		diagnostics
	};
};
//#endregion
export { ROAM_AUTHOR_PROP, ROAM_EMBED_PATH_PROP, ROAM_ISA_PROP, ROAM_MESSAGE_AUTHOR_PROP, ROAM_MESSAGE_TIMESTAMP_PROP, ROAM_MESSAGE_URL_PROP, ROAM_PAGE_ALIAS_PROP, ROAM_TIMESTAMP_PROP, ROAM_URL_PROP, collectAliasesFromPropertyValues, collectAliasesFromRoamSemanticRefListProperties, collectAliasesFromRoamSemanticRefListValue, collectPageAliases, derivePropertiesFromContent, explodePageTokens, inferRefListTargetTypes, isDailyNoteAlias, isRoamSemanticRefListProperty, nonStandardPageAliasValues, normalizeRoamPropertyValue, parsePageTokenList, propertiesFromRoam, uniqueExactStrings };

//# sourceMappingURL=properties.js.map