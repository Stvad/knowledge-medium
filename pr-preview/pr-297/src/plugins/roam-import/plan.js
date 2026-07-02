import { addBlockTypeToProperties, aliasesProp } from "../../data/properties.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { uniqueStrings } from "../../utils/array.js";
import { parseBlockRefs } from "../references/referenceParser.js";
import { srsNextReviewDateProp } from "../srs-rescheduling/schema.js";
import { applyHeading, collectContentRefUids, rewriteRoamContent } from "./content.js";
import { resolveDailyPage, roamBlockId } from "./ids.js";
import { getExtraRoamProps } from "./types.js";
import { ROAM_AUTHOR_PROP, ROAM_EMBED_PATH_PROP, ROAM_ISA_PROP, ROAM_MESSAGE_AUTHOR_PROP, ROAM_MESSAGE_TIMESTAMP_PROP, ROAM_MESSAGE_URL_PROP, ROAM_PAGE_ALIAS_PROP, ROAM_TIMESTAMP_PROP, ROAM_URL_PROP, collectAliasesFromPropertyValues, collectAliasesFromRoamSemanticRefListProperties, collectPageAliases, derivePropertiesFromContent, nonStandardPageAliasValues, normalizeRoamPropertyValue, propertiesFromRoam, uniqueExactStrings } from "./properties.js";
import { extractRoamTodoMarker } from "./todo.js";
import { parseRoamImportReferences } from "./references.js";
import { extractSrsScheduleMarker, findPromotedSrsScheduleInChildren, hasSrsScheduleDate, hasSrsScheduleFields, isSrsScheduleMarkerOnly, propertiesFromSrsSchedule } from "./srsMarkers.js";
import { computePromotedFromChildren } from "./promotion.js";
import { collectRoamMemoEntries, propertiesFromRoamMemo, srsSourceConflictDiagnostics } from "./roamMemo.js";
//#region src/plugins/roam-import/plan.ts
var cloneTimestamp = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
var collectUidRefs = (block) => {
	return (block.refs ?? block[":block/refs"] ?? []).map((ref) => ref.uid ?? ref[":block/uid"]).filter((uid) => typeof uid === "string" && uid.length > 0);
};
var collectRoamProps = (block) => {
	const fromBlockProps = {
		...block[":block/props"] ?? {},
		...block.props ?? {}
	};
	if (block[":children/view-type"]) fromBlockProps[":children/view-type"] = block[":children/view-type"];
	if (block[":block/view-type"]) fromBlockProps[":block/view-type"] = block[":block/view-type"];
	const createUserUid = block[":create/user"]?.[":user/uid"];
	if (createUserUid) fromBlockProps[":create/user"] = createUserUid;
	const editUserUid = block[":edit/user"]?.[":user/uid"];
	if (editUserUid) fromBlockProps[":edit/user"] = editUserUid;
	if (":log/id" in block && typeof block[":log/id"] === "number") fromBlockProps[":log/id"] = block[":log/id"];
	if ("text-align" in block && typeof block["text-align"] === "string") fromBlockProps["text-align"] = block["text-align"];
	if ("emojis" in block && block.emojis !== void 0) fromBlockProps.emojis = block.emojis;
	return {
		...fromBlockProps,
		...getExtraRoamProps(block)
	};
};
var buildBlock = (ctx, block, parentId, siblingIndex, pushDescendant) => {
	const id = ctx.uidMap.get(block.uid);
	if (!id) throw new Error(`Roam uid not in uidMap: ${block.uid}`);
	const children = block.children ?? [];
	if (ctx.emittedBlockUids.has(block.uid)) {
		for (let i = 0; i < children.length; i++) buildBlock(ctx, children[i], id, i, pushDescendant);
		return id;
	}
	ctx.emittedBlockUids.add(block.uid);
	const promotion = computePromotedFromChildren(children, ctx.bubbledUids);
	const promotedSrs = findPromotedSrsScheduleInChildren(children, ctx.options.workspaceId, block.uid);
	const rawContent = block.string ?? "";
	const ownSrsSchedule = extractSrsScheduleMarker(rawContent, ctx.options.workspaceId);
	if (!ownSrsSchedule && hasSrsScheduleFields(rawContent) && !hasSrsScheduleDate(rawContent)) ctx.diagnostics.push(`Roam SRS marker on uid ${block.uid} has interval/factor but no parseable daily review date; preserved literally without SRS properties.`);
	const ownSrsApplies = ownSrsSchedule !== null && !isSrsScheduleMarkerOnly(rawContent);
	const srsSchedule = ownSrsApplies ? ownSrsSchedule : promotedSrs.schedule;
	const roamMemo = ctx.roamMemoByTargetUid.get(block.uid);
	for (const d of promotion.diagnostics) ctx.diagnostics.push(d);
	for (const d of promotedSrs.diagnostics) ctx.diagnostics.push(d);
	if (ownSrsApplies && promotedSrs.schedule) ctx.diagnostics.push(`Roam SRS marker conflict on uid ${block.uid}: block has embedded SRS metadata and marker-only child metadata; applied the embedded block metadata.`);
	for (const d of srsSourceConflictDiagnostics(block.uid, srsSchedule, roamMemo)) ctx.diagnostics.push(d);
	for (const uid of promotion.bubbled) ctx.bubbledUids.add(uid);
	if (srsSchedule) ctx.aliasesUsed.add(srsSchedule.nextReviewDateAlias);
	if (roamMemo) {
		for (const snapshot of roamMemo.snapshots) ctx.aliasesUsed.add(snapshot.reviewedAtAlias);
		const latest = roamMemo.snapshots.at(-1);
		if (latest) ctx.aliasesUsed.add(latest.nextReviewDateAlias);
	}
	for (let i = 0; i < children.length; i++) buildBlock(ctx, children[i], id, i, pushDescendant);
	const todo = extractRoamTodoMarker(block.string ?? "");
	const data = composeBlockData({
		ctx,
		id,
		roamUid: block.uid,
		parentId,
		orderKey: siblingOrderKey(siblingIndex),
		rawString: todo.content,
		heading: block.heading,
		roamProps: collectRoamProps(block),
		roamRefUids: collectUidRefs(block),
		createdAt: cloneTimestamp(block["create-time"], Date.now()),
		updatedAt: cloneTimestamp(block["edit-time"] ?? block["create-time"], Date.now()),
		promotedFromChildren: {
			...promotion.promoted,
			...propertiesFromSrsSchedule(srsSchedule),
			...propertiesFromRoamMemo(roamMemo)
		}
	});
	if (srsSchedule) data.references.push({
		id: srsSchedule.nextReviewDateId,
		alias: srsSchedule.nextReviewDateAlias,
		sourceField: srsNextReviewDateProp.name
	});
	const latestMemoSnapshot = roamMemo?.snapshots.at(-1);
	if (latestMemoSnapshot) data.references.push({
		id: latestMemoSnapshot.nextReviewDateId,
		alias: latestMemoSnapshot.nextReviewDateAlias,
		sourceField: srsNextReviewDateProp.name
	});
	pushDescendant({
		data,
		roamUid: block.uid,
		todoState: todo.todoState,
		srsSchedule,
		roamMemo
	});
	return id;
};
/** Deterministic order key from a sibling index. The Roam children
*  array IS the order, so a simple `a${index}` chain preserves it.
*  Same import twice → same keys → upserts onto the same rows.
*  (Not a fractional-indexing-jittered key, but inserting between
*  imports isn't a workflow we support — re-importing replaces. */
var siblingOrderKey = (index) => `a${index.toString().padStart(6, "0")}`;
var propertyValues = (value) => value === void 0 || value === null ? [] : Array.isArray(value) ? value : [value];
var propertyKey = (value) => typeof value === "string" ? `s:${value.trim()}` : JSON.stringify(value);
var mergePropertyValues = (primary, secondary) => {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of [...propertyValues(primary), ...propertyValues(secondary)]) {
		const key = propertyKey(value);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(typeof value === "string" ? value.trim() : value);
	}
	return out.length === 1 ? out[0] : out;
};
var propertyValuesEqual = (a, b) => {
	const left = propertyValues(a).map(propertyKey).sort();
	const right = propertyValues(b).map(propertyKey).sort();
	return left.length === right.length && left.every((value, index) => value === right[index]);
};
var valuesNotIn = (values, existing) => {
	const existingKeys = new Set(propertyValues(existing).map(propertyKey));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of propertyValues(values)) {
		const key = propertyKey(value);
		if (existingKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(typeof value === "string" ? value.trim() : value);
	}
	return out;
};
var propertyValueFromList = (values) => values.length === 1 ? values[0] : [...values];
var matrixUrlValues = (value) => propertyValues(value).filter((item) => typeof item === "string" && /^https:\/\/matrix\.to\//i.test(item.trim()));
var reconcileReadwisePromotedMetadata = (roamUid, derived, promoted, ctx) => {
	const derivedProperties = { ...derived };
	const promotedProperties = { ...promoted ?? {} };
	const preservedProperties = {};
	if (!(Object.hasOwn(derivedProperties, ROAM_AUTHOR_PROP) || Object.hasOwn(derivedProperties, ROAM_URL_PROP))) return {
		derivedProperties,
		promotedProperties,
		preservedProperties
	};
	const notes = [];
	if (Object.hasOwn(promotedProperties, ROAM_URL_PROP)) {
		const promotedUrl = promotedProperties[ROAM_URL_PROP];
		const matrixUrls = matrixUrlValues(promotedUrl);
		if (matrixUrls.length > 0) {
			preservedProperties[ROAM_MESSAGE_URL_PROP] = propertyValueFromList(matrixUrls);
			notes.push(`preserved Matrix URL as ${ROAM_MESSAGE_URL_PROP}`);
		}
		if (Object.hasOwn(derivedProperties, ROAM_URL_PROP)) {
			if (valuesNotIn(promotedUrl, derivedProperties[ROAM_URL_PROP]).length > 0) {
				derivedProperties[ROAM_URL_PROP] = mergePropertyValues(derivedProperties[ROAM_URL_PROP], promotedUrl);
				notes.push(`merged promoted ${ROAM_URL_PROP} into derived ${ROAM_URL_PROP}`);
			}
			delete promotedProperties[ROAM_URL_PROP];
		}
	}
	let movedMessageMetadata = Object.hasOwn(preservedProperties, ROAM_MESSAGE_URL_PROP);
	if (Object.hasOwn(promotedProperties, ROAM_AUTHOR_PROP)) {
		const promotedAuthor = promotedProperties[ROAM_AUTHOR_PROP];
		if (!Object.hasOwn(derivedProperties, ROAM_AUTHOR_PROP) || !propertyValuesEqual(derivedProperties[ROAM_AUTHOR_PROP], promotedAuthor)) {
			preservedProperties[ROAM_MESSAGE_AUTHOR_PROP] = promotedAuthor;
			notes.push(`preserved promoted ${ROAM_AUTHOR_PROP} as ${ROAM_MESSAGE_AUTHOR_PROP}`);
			movedMessageMetadata = true;
		}
		delete promotedProperties[ROAM_AUTHOR_PROP];
	}
	if (movedMessageMetadata && Object.hasOwn(promotedProperties, ROAM_TIMESTAMP_PROP)) {
		preservedProperties[ROAM_MESSAGE_TIMESTAMP_PROP] = promotedProperties[ROAM_TIMESTAMP_PROP];
		delete promotedProperties[ROAM_TIMESTAMP_PROP];
		notes.push(`preserved promoted ${ROAM_TIMESTAMP_PROP} as ${ROAM_MESSAGE_TIMESTAMP_PROP}`);
	}
	if (notes.length > 0) {
		for (const note of notes) ctx.readwisePromotedMetadataConflictCounts.set(note, (ctx.readwisePromotedMetadataConflictCounts.get(note) ?? 0) + 1);
		if (ctx.readwisePromotedMetadataConflictSamples.length < 8) ctx.readwisePromotedMetadataConflictSamples.push(`uid ${roamUid}: ${notes.join("; ")}`);
	}
	return {
		derivedProperties,
		promotedProperties,
		preservedProperties
	};
};
var composeBlockData = (args) => {
	const { ctx, id, roamUid, parentId, orderKey, rawString, heading, roamProps, roamRefUids, createdAt, updatedAt, extraProperties, promotedFromChildren } = args;
	const rewritten = rewriteRoamContent(rawString, ctx.uidMap);
	const confirmedRefUids = new Set(roamRefUids);
	for (const u of rewritten.unresolvedBlockUids) if (confirmedRefUids.has(u)) ctx.unresolvedBlockUids.add(u);
	const derived = derivePropertiesFromContent(rewritten.content);
	for (const diagnostic of derived.diagnostics) ctx.diagnostics.push(`Readwise property extraction on uid ${roamUid}: ${diagnostic}`);
	const content = applyHeading(derived.content, heading);
	const aliasMatches = parseRoamImportReferences(content);
	for (const ref of aliasMatches) ctx.aliasesUsed.add(ref.alias);
	const blockRefMarks = parseBlockRefs(rewritten.content);
	const seenBlockRefIds = /* @__PURE__ */ new Set();
	const blockRefs = [];
	for (const mark of blockRefMarks) {
		if (seenBlockRefIds.has(mark.blockId)) continue;
		seenBlockRefIds.add(mark.blockId);
		blockRefs.push({
			id: mark.blockId,
			alias: mark.blockId
		});
	}
	const reconciled = reconcileReadwisePromotedMetadata(roamUid, derived.properties, promotedFromChildren, ctx);
	const properties = {
		...reconciled.derivedProperties,
		...reconciled.promotedProperties,
		...reconciled.preservedProperties,
		...propertiesFromRoam(roamProps),
		...extraProperties ?? {}
	};
	if (rewritten.embedPathTargets.length > 0 && properties[ROAM_EMBED_PATH_PROP] === void 0) {
		const targets = uniqueStrings(rewritten.embedPathTargets);
		properties[ROAM_EMBED_PATH_PROP] = targets.length === 1 ? targets[0] : targets;
	}
	for (const alias of collectAliasesFromPropertyValues(properties)) ctx.aliasesUsed.add(alias);
	for (const alias of collectAliasesFromRoamSemanticRefListProperties(properties)) ctx.aliasesUsed.add(alias);
	return {
		id,
		workspaceId: ctx.options.workspaceId,
		parentId,
		orderKey,
		content,
		properties,
		references: blockRefs,
		createdAt,
		updatedAt,
		userUpdatedAt: updatedAt,
		createdBy: ctx.options.currentUserId,
		updatedBy: ctx.options.currentUserId,
		deleted: false
	};
};
var buildUidMap = (pages, workspaceId) => {
	const uidMap = /* @__PURE__ */ new Map();
	const dailyByUid = /* @__PURE__ */ new Map();
	const knownUids = /* @__PURE__ */ new Set();
	const visit = (block) => {
		knownUids.add(block.uid);
		if (!uidMap.has(block.uid)) uidMap.set(block.uid, roamBlockId(workspaceId, block.uid));
		for (const child of block.children ?? []) visit(child);
	};
	for (const page of pages) {
		knownUids.add(page.uid);
		const daily = resolveDailyPage(workspaceId, page);
		if (daily) {
			dailyByUid.set(page.uid, daily);
			uidMap.set(page.uid, daily.blockId);
		} else uidMap.set(page.uid, roamBlockId(workspaceId, page.uid));
		for (const child of page.children ?? []) visit(child);
	}
	return {
		uidMap,
		dailyByUid,
		knownUids
	};
};
var occurrenceContent = (occ) => occ.content.replace(/\s+/g, " ").trim();
var occurrenceParent = (occ) => occ.kind === "page" ? "(page)" : `${occ.pageTitle}\u0000${occ.parentUid ?? "(page-root)"}`;
var occurrenceChildren = (occ) => occ.childUids.join("\0");
var quotedSample = (value) => {
	const normalized = value.replace(/\s+/g, " ").trim();
	const clipped = normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
	return JSON.stringify(clipped);
};
var collectDuplicateUidDiagnostics = (pages) => {
	const occurrences = /* @__PURE__ */ new Map();
	const add = (occ) => {
		const list = occurrences.get(occ.uid) ?? [];
		list.push(occ);
		occurrences.set(occ.uid, list);
	};
	const visitBlock = (block, pageTitle, parentUid, siblingIndex) => {
		add({
			uid: block.uid,
			kind: "block",
			pageTitle,
			parentUid,
			siblingIndex,
			content: block.string ?? "",
			childUids: (block.children ?? []).map((child) => child.uid)
		});
		for (let i = 0; i < (block.children ?? []).length; i++) visitBlock(block.children[i], pageTitle, block.uid, i);
	};
	for (const page of pages) {
		add({
			uid: page.uid,
			kind: "page",
			pageTitle: page.title,
			parentUid: null,
			siblingIndex: 0,
			content: page.title,
			childUids: (page.children ?? []).map((child) => child.uid)
		});
		for (let i = 0; i < (page.children ?? []).length; i++) visitBlock(page.children[i], page.title, page.uid, i);
	}
	const duplicates = [...occurrences.entries()].filter(([, list]) => list.length > 1).map(([uid, list]) => {
		const first = list[0];
		return {
			uid,
			list,
			first,
			contentConflict: list.some((occ) => occurrenceContent(occ) !== occurrenceContent(first)),
			parentConflict: list.some((occ) => occurrenceParent(occ) !== occurrenceParent(first)),
			childrenConflict: list.some((occ) => occurrenceChildren(occ) !== occurrenceChildren(first))
		};
	});
	if (duplicates.length === 0) return [];
	const pageDuplicates = duplicates.filter((d) => d.first.kind === "page");
	const blockDuplicates = duplicates.filter((d) => d.first.kind === "block");
	const duplicateInstances = duplicates.reduce((sum, d) => sum + d.list.length, 0);
	const contentConflicts = duplicates.filter((d) => d.contentConflict).length;
	const parentConflicts = duplicates.filter((d) => d.parentConflict).length;
	const childrenConflicts = duplicates.filter((d) => d.childrenConflict).length;
	const diagnostics = [`Duplicate Roam uid weirdness: ${duplicates.length} uid(s) appeared across ${duplicateInstances} export node instances (${blockDuplicates.length} block uid(s), ${pageDuplicates.length} page uid(s)); importer emits the first block occurrence per uid and skips later duplicate block rows. Conflicts: ${contentConflicts} content, ${parentConflicts} parent/page, ${childrenConflicts} child-list.`];
	const conflictSamples = duplicates.filter((d) => d.contentConflict || d.parentConflict || d.childrenConflict || d.list.length > 2).slice(0, 8);
	for (const d of conflictSamples) {
		const first = d.first;
		const later = d.list.find((occ) => occurrenceContent(occ) !== occurrenceContent(first) || occurrenceParent(occ) !== occurrenceParent(first) || occurrenceChildren(occ) !== occurrenceChildren(first)) ?? d.list[1];
		const conflictKinds = [
			d.contentConflict ? "content" : "",
			d.parentConflict ? "parent/page" : "",
			d.childrenConflict ? "child-list" : ""
		].filter(Boolean).join(", ") || "repeated identical node";
		diagnostics.push(`Duplicate Roam uid ${d.uid} (${d.list.length} occurrences, ${conflictKinds}); kept first on [[${pageTitleForDiagnostic(first.pageTitle)}]] at sibling ${first.siblingIndex} with content ${quotedSample(first.content)}; sample later on [[${pageTitleForDiagnostic(later.pageTitle)}]] at sibling ${later.siblingIndex} with content ${quotedSample(later.content)}.`);
	}
	return diagnostics;
};
var collectPlaceholderUids = (pages, knownUids) => {
	const out = /* @__PURE__ */ new Set();
	const visit = (block) => {
		const metadataRefUids = new Set(collectUidRefs(block));
		for (const uid of collectContentRefUids(block.string ?? "")) if (!knownUids.has(uid) && metadataRefUids.has(uid)) out.add(uid);
		for (const child of block.children ?? []) visit(child);
	};
	for (const page of pages) for (const child of page.children ?? []) visit(child);
	return [...out];
};
var collectUnconfirmedBlockRefDiagnostics = (pages, knownUids) => {
	const occurrences = [];
	const visit = (block, pageTitle) => {
		const metadataRefUids = new Set(collectUidRefs(block));
		for (const uid of collectContentRefUids(block.string ?? "")) {
			if (metadataRefUids.has(uid)) continue;
			occurrences.push({
				uid,
				blockUid: block.uid,
				pageTitle,
				targetKnown: knownUids.has(uid)
			});
		}
		for (const child of block.children ?? []) visit(child, pageTitle);
	};
	for (const page of pages) for (const child of page.children ?? []) visit(child, page.title);
	if (occurrences.length === 0) return [];
	const uniqueUids = new Set(occurrences.map((occ) => occ.uid));
	const knownUidsSeen = new Set(occurrences.filter((occ) => occ.targetKnown).map((occ) => occ.uid));
	const absentUidsSeen = new Set(occurrences.filter((occ) => !occ.targetKnown).map((occ) => occ.uid));
	const diagnostics = [`Unconfirmed Roam block-ref-looking text: ${uniqueUids.size} uid(s) appeared as ((uid)) in content without matching :block/refs metadata; ${knownUidsSeen.size} target uid(s) were present in this export and ${absentUidsSeen.size} target uid(s) were absent, so absent targets were left literal without placeholders.`];
	const sampleCount = 20;
	for (const occ of occurrences.slice(0, sampleCount)) diagnostics.push(`Unconfirmed Roam block-ref-looking text ((${occ.uid})) in block uid ${occ.blockUid} on [[${pageTitleForDiagnostic(occ.pageTitle)}]] (${occ.targetKnown ? "target present in export" : "target absent from export"}); refs metadata did not confirm it.`);
	if (occurrences.length > sampleCount) diagnostics.push(`${occurrences.length - sampleCount} more unconfirmed Roam block-ref-looking text occurrence(s) omitted from this report section.`);
	return diagnostics;
};
var collectPageTitleDiagnostics = (pages) => {
	let blank = 0;
	let whitespace = 0;
	let newline = 0;
	let long = 0;
	for (const page of pages) {
		if (page.title === "") blank += 1;
		if (page.title !== page.title.trim()) whitespace += 1;
		if (page.title.includes("\n")) newline += 1;
		if (page.title.length > 160) long += 1;
	}
	const parts = [
		blank > 0 ? `${blank} blank` : "",
		whitespace > 0 ? `${whitespace} with leading/trailing whitespace` : "",
		newline > 0 ? `${newline} with newlines` : "",
		long > 0 ? `${long} longer than 160 chars` : ""
	].filter(Boolean);
	return parts.length > 0 ? [`Roam page title weirdness: ${parts.join(", ")}; imported titles literally.`] : [];
};
var ROAM_COMMAND_RE = /\{\{\s*(?:\[\[([^\]]+)\]\]|([^\s:{}]+))/g;
var ROAM_COMMANDS_HANDLED = new Set([
	"TODO",
	"DONE",
	"embed",
	"embed-path"
]);
var ROAM_COMMANDS_KNOWN_FOLLOW_UP = new Set([
	"query",
	"audio",
	"video",
	"youtube",
	"iframe",
	"pdf",
	"tweet",
	"table",
	"calc"
]);
var commandScanContent = (content) => {
	let out = "";
	let i = 0;
	while (i < content.length) {
		if (content.startsWith("```", i)) {
			const end = content.indexOf("```", i + 3);
			const rangeEnd = end < 0 ? content.length : end + 3;
			out += " ".repeat(rangeEnd - i);
			i = rangeEnd;
			continue;
		}
		if (content[i] === "`") {
			const end = content.indexOf("`", i + 1);
			if (end < 0) break;
			out += " ".repeat(end + 1 - i);
			i = end + 1;
			continue;
		}
		out += content[i];
		i += 1;
	}
	return out;
};
var collectRoamCommands = (content) => {
	const out = [];
	ROAM_COMMAND_RE.lastIndex = 0;
	let match;
	const scannable = commandScanContent(content);
	while ((match = ROAM_COMMAND_RE.exec(scannable)) !== null) {
		const name = (match[1] ?? match[2] ?? "").trim();
		if (name) out.push(name);
	}
	return out;
};
var formatCommandCounts = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([name, count]) => `${name} ${count}`).join(", ");
var collectRoamCommandFollowUpDiagnostics = (pages) => {
	const knownCounts = /* @__PURE__ */ new Map();
	const unknownCounts = /* @__PURE__ */ new Map();
	const visit = (block) => {
		for (const name of collectRoamCommands(block.string ?? "")) {
			if (ROAM_COMMANDS_HANDLED.has(name)) continue;
			if (ROAM_COMMANDS_KNOWN_FOLLOW_UP.has(name)) knownCounts.set(name, (knownCounts.get(name) ?? 0) + 1);
			else unknownCounts.set(name, (unknownCounts.get(name) ?? 0) + 1);
		}
		for (const child of block.children ?? []) visit(child);
	};
	for (const page of pages) for (const child of page.children ?? []) visit(child);
	const diagnostics = [];
	const knownTotal = [...knownCounts.values()].reduce((sum, count) => sum + count, 0);
	if (knownTotal > 0) diagnostics.push(`Roam command follow-up: preserved ${knownTotal} known command occurrence(s) literally (${formatCommandCounts(knownCounts)}); media/query normalization is still a follow-up.`);
	const unknownTotal = [...unknownCounts.values()].reduce((sum, count) => sum + count, 0);
	if (unknownTotal > 0) diagnostics.push(`Unknown Roam command follow-up: preserved ${unknownTotal} command occurrence(s) literally (${formatCommandCounts(unknownCounts)}); review custom command handling.`);
	return diagnostics;
};
var appendReadwisePromotedMetadataDiagnostics = (diagnostics, ctx) => {
	const total = [...ctx.readwisePromotedMetadataConflictCounts.values()].reduce((sum, count) => sum + count, 0);
	if (total === 0) return;
	const formattedCounts = [...ctx.readwisePromotedMetadataConflictCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([note, count]) => `${note} ${count}`).join(", ");
	diagnostics.push(`Readwise promoted metadata conflicts: handled ${total} promoted child metadata conflict(s) without letting Matrix/source metadata overwrite article metadata (${formattedCounts}).`);
	for (const sample of ctx.readwisePromotedMetadataConflictSamples) diagnostics.push(`Readwise promoted metadata conflict sample: ${sample}.`);
};
var pageTitleForDiagnostic = (title) => {
	const normalized = title.replace(/\s+/g, " ").trim();
	return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
};
var appendPageAliasDiagnostics = (diagnostics, page, properties) => {
	const values = nonStandardPageAliasValues(properties);
	if (values.length === 0) return;
	const sample = values.slice(0, 3).map((value) => JSON.stringify(value)).join(", ");
	diagnostics.push(`Non-standard page_alias on [[${pageTitleForDiagnostic(page.title)}]] (uid ${page.uid}) was not used for alias-rule merging: ${sample}`);
};
var planImport = (pages, options) => {
	const { uidMap, dailyByUid, knownUids } = buildUidMap(pages, options.workspaceId);
	const roamMemo = collectRoamMemoEntries(pages, knownUids, options.workspaceId);
	const placeholders = collectPlaceholderUids(pages, knownUids).map((roamUid) => {
		const blockId = roamBlockId(options.workspaceId, roamUid);
		uidMap.set(roamUid, blockId);
		return {
			blockId,
			roamUid
		};
	});
	const diagnostics = [];
	diagnostics.push(...collectDuplicateUidDiagnostics(pages));
	diagnostics.push(...collectPageTitleDiagnostics(pages));
	diagnostics.push(...collectRoamCommandFollowUpDiagnostics(pages));
	diagnostics.push(...collectUnconfirmedBlockRefDiagnostics(pages, knownUids));
	const ctx = {
		options,
		uidMap,
		roamMemoByTargetUid: roamMemo.byTargetUid,
		aliasesUsed: /* @__PURE__ */ new Set(),
		unresolvedBlockUids: /* @__PURE__ */ new Set(),
		diagnostics,
		emittedBlockUids: /* @__PURE__ */ new Set(),
		readwisePromotedMetadataConflictCounts: /* @__PURE__ */ new Map(),
		readwisePromotedMetadataConflictSamples: [],
		bubbledUids: /* @__PURE__ */ new Set()
	};
	const preparedPages = [];
	const descendants = [];
	const pushDescendant = (b) => descendants.push(b);
	for (const page of pages) {
		const daily = dailyByUid.get(page.uid);
		const pageBlockId = uidMap.get(page.uid);
		if (!pageBlockId) throw new Error(`Page uid not in uidMap: ${page.uid}`);
		const childIds = [];
		const pageChildren = page.children ?? [];
		const pagePromotion = computePromotedFromChildren(pageChildren, ctx.bubbledUids);
		for (const d of pagePromotion.diagnostics) diagnostics.push(d);
		for (const uid of pagePromotion.bubbled) ctx.bubbledUids.add(uid);
		for (let i = 0; i < pageChildren.length; i++) childIds.push(buildBlock(ctx, pageChildren[i], pageBlockId, i, pushDescendant));
		const promotedFromChildren = pagePromotion.promoted;
		const pageRoamProps = collectRoamProps(page);
		const pageProperties = {
			...promotedFromChildren,
			...propertiesFromRoam(pageRoamProps)
		};
		const pageAliases = collectPageAliases(pageProperties);
		for (const alias of collectAliasesFromRoamSemanticRefListProperties(pageProperties)) ctx.aliasesUsed.add(alias);
		appendPageAliasDiagnostics(diagnostics, page, pageProperties);
		if (daily) {
			preparedPages.push({
				blockId: pageBlockId,
				roamUid: page.uid,
				title: page.title,
				isDaily: true,
				iso: daily.iso,
				childIds,
				promotedFromChildren: pageProperties,
				pageAliases
			});
			continue;
		}
		const pageData = composeBlockData({
			ctx,
			id: pageBlockId,
			roamUid: page.uid,
			parentId: null,
			orderKey: "a0",
			rawString: page.title,
			heading: void 0,
			roamProps: pageRoamProps,
			roamRefUids: collectUidRefs(page),
			createdAt: cloneTimestamp(page["create-time"], Date.now()),
			updatedAt: cloneTimestamp(page["edit-time"] ?? page["create-time"], Date.now()),
			extraProperties: addBlockTypeToProperties({ [aliasesProp.name]: aliasesProp.codec.encode(uniqueExactStrings([page.title, ...pageAliases])) }, PAGE_TYPE),
			promotedFromChildren
		});
		preparedPages.push({
			blockId: pageBlockId,
			roamUid: page.uid,
			title: page.title,
			isDaily: false,
			data: pageData,
			childIds,
			promotedFromChildren: pageProperties,
			pageAliases
		});
	}
	if (placeholders.length > 0) diagnostics.push(`${placeholders.length} block-ref uid(s) not present in this export — created as empty placeholder blocks; a future import that includes them will upsert onto the same deterministic ids.`);
	if (ctx.unresolvedBlockUids.size > 0) diagnostics.push(`[bug] ${ctx.unresolvedBlockUids.size} content uid(s) leaked past placeholder registration: ${[...ctx.unresolvedBlockUids].slice(0, 5).join(", ")}`);
	appendReadwisePromotedMetadataDiagnostics(diagnostics, ctx);
	return {
		pages: preparedPages,
		descendants,
		placeholders,
		uidMap,
		aliasesUsed: ctx.aliasesUsed,
		diagnostics,
		roamMemo: roamMemo.summary
	};
};
//#endregion
export { ROAM_AUTHOR_PROP, ROAM_EMBED_PATH_PROP, ROAM_ISA_PROP, ROAM_PAGE_ALIAS_PROP, computePromotedFromChildren, extractRoamTodoMarker, extractSrsScheduleMarker, normalizeRoamPropertyValue, parseRoamImportReferences, planImport };

//# sourceMappingURL=plan.js.map