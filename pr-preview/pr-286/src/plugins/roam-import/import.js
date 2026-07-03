import { normalizeReferences } from "../../data/api/blockData.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { DeletedConflictError } from "../../data/api/errors.js";
import { derivedRefKey, reconcileDerived } from "../../data/api/derivedData.js";
import "../../data/api/index.js";
import { addBlockTypeToProperties, aliasesProp, hasBlockType, typesProp } from "../../data/properties.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { aliasSeatReaderFromDb, aliasSeatReaderFromTx, resolveAliasSeatId } from "../../data/targets.js";
import { dailyNoteBlockId, getOrCreateDailyNote } from "../daily-notes/dailyNotes.js";
import { isRetainableAbsentRef, projectPropertyReferences } from "../references/referenceProjection.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import { SRS_SM25_TYPE, srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSnapshotHistoryProp } from "../srs-rescheduling/schema.js";
import { TODO_TYPE, roamTodoStateProp, statusProp } from "../todo/schema.js";
import "../daily-notes/index.js";
import { uniqueExactStrings } from "./properties.js";
import { parseRoamImportReferences } from "./references.js";
import { planImport } from "./plan.js";
import { collectTypeCandidates } from "./typeCandidates.js";
import { writeImportLog } from "./report.js";
import { applySchemaReconciliation, collectSchemaReconciliationPlan, normalizeListPropertyValues, normalizeRefPropertyValues, normalizeStringPropertyValues } from "./schemaReconciliation.js";
//#region src/plugins/roam-import/import.ts
/** How many descendant rows to write per tx. Trade-off:
*  - Smaller chunks → smaller TxEngine snapshot Map per commit and
*    faster handle-invalidation pass after each commit, but more
*    per-tx overhead (BEGIN/COMMIT, command_events row, undo entry,
*    one PowerSync upload tx per chunk).
*  - Larger chunks → fewer commit-time costs amortised over more
*    rows, but the snapshot Map and the post-commit O(snapshots)
*    work blow up on huge imports.
*
*  5K is a balance for the 150-MB-class graphs the optimisation
*  targets — empirically the snapshot pass starts to feel sluggish
*  past ~10K-20K, and per-tx fixed cost dominates below ~1K. Tune
*  later if profiling moves the needle. Not exposed as an option
*  for now; callers don't need a knob, they need it fast. */
var DESCENDANT_CHUNK_SIZE = 5e3;
var TAG_TO_TYPE = {
	TODO: {
		typeId: TODO_TYPE,
		appOwnedInit: { [statusProp.name]: "open" },
		sourceMirror: { [roamTodoStateProp.name]: "TODO" }
	},
	DONE: {
		typeId: TODO_TYPE,
		appOwnedInit: { [statusProp.name]: "done" },
		sourceMirror: { [roamTodoStateProp.name]: "DONE" }
	}
};
var ROAM_SOURCE_PREFIXES = ["roam:"];
var isRoamSourceField = (name) => ROAM_SOURCE_PREFIXES.some((prefix) => name.startsWith(prefix));
var PAGE_SOURCE_FIELDS = [aliasesProp.name, typesProp.name];
var importRoam = async (pages, repo, options) => {
	const start = Date.now();
	const log = (msg) => options.onProgress?.(msg);
	let phaseStart = start;
	const sinceLastPhase = () => {
		const now = Date.now();
		const s = ((now - phaseStart) / 1e3).toFixed(1);
		phaseStart = now;
		return `${s}s`;
	};
	log(`Planning ${pages.length} top-level pages…`);
	const plan = planImport(pages, {
		workspaceId: options.workspaceId,
		currentUserId: options.currentUserId
	});
	log(`Planned ${plan.pages.length} pages, ${plan.descendants.length} descendant blocks, ${plan.aliasesUsed.size} aliases, ${plan.placeholders.length} placeholders (${sinceLastPhase()})`);
	log(`Reconciling ${plan.pages.length} pages against existing workspace…`);
	const reconciliations = await reconcilePages(plan.pages, repo, options.workspaceId, plan.diagnostics, log);
	const reparentMap = buildReparentMap(reconciliations);
	log(`Reconciled ${reconciliations.length} pages (${reconciliations.filter((r) => r.merging).length} merge into existing) (${sinceLastPhase()})`);
	log(`Resolving ${plan.aliasesUsed.size} aliases…`);
	const aliasResolution = await resolveAliases(plan.aliasesUsed, reconciliations, repo, options.workspaceId, log);
	log(`Resolved ${aliasResolution.aliasIdMap.size} aliases (${aliasResolution.aliasesNeedingSeat.length} need new seat rows) (${sinceLastPhase()})`);
	for (const desc of plan.descendants) patchAliasReferences(desc.data, aliasResolution.aliasIdMap);
	for (const page of plan.pages) if (page.data) patchAliasReferences(page.data, aliasResolution.aliasIdMap);
	log(`Patched references on ${plan.descendants.length + plan.pages.length} blocks (${sinceLastPhase()})`);
	const typeSnapshot = repo.snapshotTypeRegistries();
	const typeCandidates = collectTypeCandidates(plan, typeSnapshot.types, aliasResolution.aliasIdMap);
	if (typeCandidates.length > 0) log(`Found ${typeCandidates.length} isa:: type candidates`);
	const allPlannedBlocks = [];
	for (const desc of plan.descendants) allPlannedBlocks.push(desc.data);
	for (const page of plan.pages) if (page.data) allPlannedBlocks.push(page.data);
	else if (Object.keys(page.promotedFromChildren).length > 0) allPlannedBlocks.push({
		id: page.blockId,
		workspaceId: options.workspaceId,
		parentId: null,
		orderKey: "a0",
		content: page.title,
		properties: page.promotedFromChildren,
		references: [],
		createdAt: 0,
		updatedAt: 0,
		userUpdatedAt: 0,
		createdBy: options.currentUserId,
		updatedBy: options.currentUserId,
		deleted: false
	});
	const reconciliation = collectSchemaReconciliationPlan(allPlannedBlocks, repo);
	if (reconciliation.skippedReserved.length > 0) plan.diagnostics.push(`Skipped reserved names during schema reconciliation: ${reconciliation.skippedReserved.join(", ")}`);
	plan.diagnostics.push(...reconciliation.diagnostics);
	if (reconciliation.toRegister.length > 0 && !options.dryRun) {
		log(`Registering ${reconciliation.toRegister.length} new property schemas…`);
		await applySchemaReconciliation(reconciliation.toRegister, repo, plan.diagnostics);
		log(`Registered ${reconciliation.toRegister.length} property schemas (${sinceLastPhase()})`);
	}
	const stringPropertyNames = /* @__PURE__ */ new Set();
	for (const r of reconciliation.toRegister) if (r.presetId === "string" && isRoamSourceField(r.name)) stringPropertyNames.add(r.name);
	for (const [name, schema] of repo.propertySchemas) if (schema.codec.type === "string" && isRoamSourceField(name)) stringPropertyNames.add(name);
	normalizeStringPropertyValues(allPlannedBlocks, stringPropertyNames);
	const listPropertyNames = /* @__PURE__ */ new Set();
	for (const r of reconciliation.toRegister) if (r.presetId === "list" && isRoamSourceField(r.name)) listPropertyNames.add(r.name);
	for (const [name, schema] of repo.propertySchemas) if (schema.codec.type === "list" && isRoamSourceField(name)) listPropertyNames.add(name);
	normalizeListPropertyValues(allPlannedBlocks, listPropertyNames);
	const refPropertyKinds = /* @__PURE__ */ new Map();
	for (const r of reconciliation.toRegister) if (r.presetId === "refList") refPropertyKinds.set(r.name, "refList");
	for (const [name, schema] of repo.propertySchemas) if (schema.codec.type === "refList") refPropertyKinds.set(name, "refList");
	else if (schema.codec.type === "ref") refPropertyKinds.set(name, "ref");
	if (refPropertyKinds.size > 0) normalizeRefPropertyValues(allPlannedBlocks, refPropertyKinds, aliasResolution.aliasIdMap, plan.diagnostics);
	for (const block of allPlannedBlocks) block.references = referencesWithProjectedProperties(block.references, projectPropertyReferences(block, repo.propertySchemas), block, block, repo.propertySchemas);
	for (const page of plan.pages) {
		if (!page.data) continue;
		for (const name of Object.keys(page.promotedFromChildren)) if (name in page.data.properties) page.promotedFromChildren[name] = page.data.properties[name];
	}
	if (options.dryRun) return {
		pagesCreated: reconciliations.filter((r) => !r.merging && !r.page.isDaily).length,
		pagesMerged: reconciliations.filter((r) => r.merging).length,
		pagesDaily: reconciliations.filter((r) => r.page.isDaily).length,
		blocksWritten: plan.descendants.length,
		aliasesResolved: aliasResolution.aliasIdMap.size,
		aliasBlocksCreated: 0,
		typeCandidates,
		roamMemo: plan.roamMemo,
		placeholdersCreated: plan.placeholders.length,
		diagnostics: plan.diagnostics,
		durationMs: Date.now() - start,
		dryRun: true
	};
	const dailyIsos = collectDailyIsos(reconciliations, aliasResolution.aliasIdMap, plan.aliasesUsed, plan.diagnostics);
	if (dailyIsos.length > 0) log(`Materialising ${dailyIsos.length} daily notes…`);
	for (let i = 0; i < dailyIsos.length; i++) {
		const iso = dailyIsos[i];
		try {
			await getOrCreateDailyNote(repo, options.workspaceId, iso);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			plan.diagnostics.push(`Failed to materialise daily note for ${iso}: ${message}`);
			log(`Daily note ${iso} failed: ${message} — continuing`);
		}
		if ((i + 1) % 100 === 0 && i + 1 < dailyIsos.length) log(`Daily notes ${i + 1}/${dailyIsos.length}`);
	}
	if (dailyIsos.length > 0) log(`Materialised ${dailyIsos.length} daily notes (${sinceLastPhase()})`);
	let pagesCreated = 0;
	let pagesMerged = 0;
	let aliasBlocksCreated = 0;
	const pagesDaily = reconciliations.filter((r) => r.page.isDaily).length;
	await repo.tx(async (tx) => {
		for (const alias of aliasResolution.aliasesNeedingSeat) if ((await ensureAliasSeat(tx, repo, {
			alias,
			workspaceId: options.workspaceId
		}, typeSnapshot)).inserted) aliasBlocksCreated += 1;
		for (const placeholder of plan.placeholders) await ensurePlaceholderRow(tx, {
			id: placeholder.blockId,
			workspaceId: options.workspaceId
		});
		const rootReconciliations = reconciliations.filter((r) => !r.aliasRuleMerged);
		const aliasRuleMergedReconciliations = reconciliations.filter((r) => r.aliasRuleMerged);
		for (const recon of rootReconciliations) {
			if (recon.page.isDaily) {
				await mergePageAliases(tx, recon.finalId, recon.aliasesToApply);
				await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren, repo.propertySchemas);
				continue;
			}
			if (recon.merging) {
				pagesMerged += 1;
				await mergeIntoExistingPage(tx, recon, repo, typeSnapshot);
				await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren, repo.propertySchemas);
				continue;
			}
			pagesCreated += 1;
			if (!recon.page.data) throw new Error("Non-daily, non-merging page must have data");
			await upsertImportedBlock(tx, withPageAliases(recon.page.data, recon.aliasesToApply), repo.propertySchemas, pageImportMergeOptions());
		}
		for (const recon of aliasRuleMergedReconciliations) {
			if (!recon.page.isDaily) pagesMerged += 1;
			await mergePageAliases(tx, recon.finalId, recon.aliasesToApply);
			await applyPromotedAttributes(tx, recon.finalId, recon.page.promotedFromChildren, repo.propertySchemas);
		}
	}, {
		scope: ChangeScope.BlockDefault,
		description: "roam import: pages"
	});
	log(`Wrote frontmatter: ${plan.placeholders.length} placeholders, ${pagesCreated} new pages, ${pagesMerged} merged, ${pagesDaily} daily-notes, ${aliasBlocksCreated} alias seats (${sinceLastPhase()})`);
	const total = plan.descendants.length;
	const chunkSize = options.descendantChunkSize ?? DESCENDANT_CHUNK_SIZE;
	const descendantsStart = Date.now();
	let written = 0;
	for (let chunkStart = total - 1; chunkStart >= 0; chunkStart -= chunkSize) {
		const chunkEnd = Math.max(0, chunkStart - chunkSize + 1);
		const chunkBeganAt = Date.now();
		await repo.tx(async (tx) => {
			for (let i = chunkStart; i >= chunkEnd; i--) {
				const desc = plan.descendants[i];
				const data = applyReparent(desc.data, reparentMap);
				appendRoamMemoExistingConflicts(plan.diagnostics, desc, await tx.get(data.id));
				await upsertImportedBlock(tx, data, repo.propertySchemas, mergeOptionsForDescendant(desc));
				await applyMappedTypesInTx(tx, desc, repo, typeSnapshot);
			}
		}, {
			scope: ChangeScope.BlockDefault,
			description: "roam import: descendants"
		});
		const chunkRows = chunkStart - chunkEnd + 1;
		written += chunkRows;
		const chunkSec = (Date.now() - chunkBeganAt) / 1e3;
		const elapsedSec = (Date.now() - descendantsStart) / 1e3;
		const rate = elapsedSec > 0 ? written / elapsedSec : 0;
		const remaining = total - written;
		const etaSec = rate > 0 ? remaining / rate : 0;
		log(`Wrote descendants ${written}/${total} (chunk ${chunkRows} rows in ${chunkSec.toFixed(1)}s, ${rate.toFixed(0)} rows/s, eta ~${formatEta(etaSec)})`);
	}
	if (total > 0) log(`All ${total} descendants written (${sinceLastPhase()})`);
	try {
		await writeImportLog(repo, options.workspaceId, {
			pagesCreated,
			pagesMerged,
			pagesDaily,
			blocksWritten: plan.descendants.length,
			placeholdersCreated: plan.placeholders.length,
			aliasBlocksCreated,
			typeCandidates,
			roamMemo: plan.roamMemo,
			durationMs: Date.now() - start,
			diagnostics: plan.diagnostics,
			uidMap: plan.uidMap
		});
		log(`Wrote import-log block to today's daily (${sinceLastPhase()})`);
	} catch (err) {
		log(`Could not write import-log block: ${err instanceof Error ? err.message : String(err)}`);
	}
	return {
		pagesCreated,
		pagesMerged,
		pagesDaily,
		blocksWritten: plan.descendants.length,
		aliasesResolved: aliasResolution.aliasIdMap.size,
		aliasBlocksCreated,
		typeCandidates,
		roamMemo: plan.roamMemo,
		placeholdersCreated: plan.placeholders.length,
		diagnostics: plan.diagnostics,
		durationMs: Date.now() - start,
		dryRun: false
	};
};
var formatEta = (seconds) => {
	if (!Number.isFinite(seconds) || seconds < 0) return "?";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return `${m}m${String(s).padStart(2, "0")}s`;
	}
	const h = Math.floor(seconds / 3600);
	const m = Math.round(seconds % 3600 / 60);
	return `${h}h${String(m).padStart(2, "0")}m`;
};
var VALID_ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Distinct ISO dates that need a daily-note row before the main tx
*  commits — the union of (imported daily pages, daily-shaped aliases
*  referenced in content). Deduplicated so a 1000-block import that
*  references `[[2026-04-28]]` 500 times calls getOrCreateDailyNote
*  once per unique date, not once per occurrence.
*
*  Defensive iso-shape filter at the perimeter: any iso that fails the
*  strict regex would crash `getOrCreateDailyNote`, killing the whole
*  import for one bad page. Drop it here and surface it via
*  `diagnostics`, mirroring how the planner handles other lossy
*  fallbacks. */
var collectDailyIsos = (recons, aliasIdMap, aliasesUsed, diagnostics) => {
	const isos = /* @__PURE__ */ new Set();
	for (const r of recons) {
		if (!r.page.isDaily || !r.page.iso) continue;
		if (!VALID_ISO.test(r.page.iso)) {
			diagnostics.push(`Daily page "${r.page.title}" (uid ${r.page.roamUid}) has non-standard ISO "${r.page.iso}"; skipping daily-note materialisation. The page row will still be created, but downstream steps may fail — investigate the source data or upstream resolveDailyPage path.`);
			continue;
		}
		isos.add(r.page.iso);
	}
	for (const alias of aliasesUsed) {
		const parsed = parseLiteralDailyPageTitle(alias);
		if (!parsed || !aliasIdMap.has(alias)) continue;
		if (!VALID_ISO.test(parsed.iso)) {
			diagnostics.push(`Alias "${alias}" parsed to non-standard ISO "${parsed.iso}" — skipping.`);
			continue;
		}
		isos.add(parsed.iso);
	}
	return [...isos];
};
/** Idempotent seat materialisation for unowned aliases. Mirrors
*  ensureAliasTarget's indexed-seat probe, but writes `content: alias`
*  (visible title for UI) instead of empty content. Slot 0 is only the
*  happy path; a live row there may be a post-rename occupant that no
*  longer claims this alias. */
var ensureAliasSeat = async (tx, repo, { alias, workspaceId }, typeSnapshot) => {
	const id = await resolveAliasSeatId(aliasSeatReaderFromTx(tx), alias, workspaceId);
	const properties = { [aliasesProp.name]: aliasesProp.codec.encode([alias]) };
	try {
		const result = await tx.createOrGet({
			id,
			workspaceId,
			parentId: null,
			orderKey: "a0",
			content: alias,
			properties
		});
		if (result.inserted) await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: [alias] }, typeSnapshot);
		return result;
	} catch (err) {
		if (!(err instanceof DeletedConflictError)) throw err;
		await tx.restore(id, {
			content: alias,
			properties,
			references: []
		});
		await tx.move(id, {
			parentId: null,
			orderKey: "a0"
		});
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: [alias] }, typeSnapshot);
		return {
			id,
			inserted: true
		};
	}
};
var quotedList = (values) => {
	const quoted = values.map((value) => `'${value}'`);
	if (quoted.length <= 2) return quoted.join(" and ");
	return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
};
var buildPageAliasRulePlan = (preparedPages) => {
	const directOwnerByAlias = /* @__PURE__ */ new Map();
	const conflictOwnerByTitle = /* @__PURE__ */ new Map();
	const validAliasesByTitle = /* @__PURE__ */ new Map();
	const diagnostics = [];
	const pageOrder = new Map(preparedPages.map((page, index) => [page.title, index]));
	const pageByTitle = new Map(preparedPages.map((page) => [page.title, page]));
	let dailyAliasMergeSkips = 0;
	const dailyAliasMergeSamples = [];
	const skipDailyAliasMerge = (page, alias) => {
		const aliasPage = pageByTitle.get(alias);
		if (!(page.isDaily || aliasPage?.isDaily === true || parseLiteralDailyPageTitle(alias) !== null)) return false;
		dailyAliasMergeSkips += 1;
		if (dailyAliasMergeSamples.length < 8) dailyAliasMergeSamples.push(`[[${page.title}]] -> [[${alias}]]`);
		return true;
	};
	for (const page of preparedPages) for (const alias of uniqueExactStrings(page.pageAliases)) {
		if (alias === page.title) continue;
		if (skipDailyAliasMerge(page, alias)) continue;
		const aliases = validAliasesByTitle.get(page.title) ?? [];
		aliases.push(alias);
		validAliasesByTitle.set(page.title, aliases);
		const existingOwner = directOwnerByAlias.get(alias);
		if (existingOwner && existingOwner !== page.title) {
			conflictOwnerByTitle.set(page.title, existingOwner);
			continue;
		}
		directOwnerByAlias.set(alias, page.title);
	}
	if (dailyAliasMergeSkips > 0) diagnostics.push(`Skipped ${dailyAliasMergeSkips} daily-shaped page_alias merge(s) to avoid merging daily notes into regular pages; samples: ${dailyAliasMergeSamples.join(", ")}.`);
	const rootCache = /* @__PURE__ */ new Map();
	const chooseCycleRoot = (cycle) => [...cycle].sort((a, b) => {
		const aOrder = pageOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
		const bOrder = pageOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return a.localeCompare(b);
	})[0];
	const rootFor = (title) => {
		const cached = rootCache.get(title);
		if (cached) return cached;
		const path = [];
		const seen = /* @__PURE__ */ new Map();
		let current = title;
		const remember = (root) => {
			for (const titleInPath of path) rootCache.set(titleInPath, root);
			return root;
		};
		while (true) {
			const cachedCurrent = rootCache.get(current);
			if (cachedCurrent) return remember(cachedCurrent);
			const seenAt = seen.get(current);
			if (seenAt !== void 0) {
				const cycle = path.slice(seenAt);
				const root = chooseCycleRoot(cycle);
				diagnostics.push(`page_alias cycle involving ${cycle.map((t) => `[[${t}]]`).join(", ")}; using [[${root}]] as the canonical page.`);
				return remember(root);
			}
			seen.set(current, path.length);
			path.push(current);
			const owner = directOwnerByAlias.get(current) ?? conflictOwnerByTitle.get(current);
			if (!owner || owner === current) return remember(current);
			current = owner;
		}
	};
	const rootByTitle = /* @__PURE__ */ new Map();
	for (const page of preparedPages) rootByTitle.set(page.title, rootFor(page.title));
	const aliasesByRootTitle = /* @__PURE__ */ new Map();
	const mergedTitlesByRootTitle = /* @__PURE__ */ new Map();
	for (const page of preparedPages) {
		const root = rootByTitle.get(page.title) ?? page.title;
		if (root === page.title) aliasesByRootTitle.set(root, [root]);
	}
	for (const page of [...preparedPages].reverse()) {
		const root = rootByTitle.get(page.title) ?? page.title;
		const aliases = aliasesByRootTitle.get(root) ?? [root];
		if (page.title !== root) aliases.push(page.title);
		for (const alias of uniqueExactStrings(validAliasesByTitle.get(page.title) ?? [])) aliases.push(alias);
		aliasesByRootTitle.set(root, uniqueExactStrings(aliases));
	}
	for (const [root, aliases] of aliasesByRootTitle) {
		const merged = aliases.filter((alias) => {
			if (alias === root) return false;
			const aliasPage = pageByTitle.get(alias);
			return Boolean(aliasPage && rootByTitle.get(aliasPage.title) === root);
		});
		if (merged.length > 0) mergedTitlesByRootTitle.set(root, merged);
	}
	for (const [root, mergedTitles] of mergedTitlesByRootTitle) diagnostics.push(`[[${root}]] also had ${quotedList(mergedTitles)} merged in bc of the alias rule`);
	return {
		rootByTitle,
		aliasesByRootTitle,
		diagnostics
	};
};
var lookupExistingPageByAliases = async (repo, workspaceId, aliases) => {
	for (const alias of aliases) {
		const existing = await repo.query.aliasLookup({
			workspaceId,
			alias
		}).load();
		if (existing && hasBlockType(existing, "page")) return existing;
	}
	return null;
};
var reconcilePages = async (preparedPages, repo, workspaceId, diagnostics, log) => {
	const aliasRule = buildPageAliasRulePlan(preparedPages);
	diagnostics.push(...aliasRule.diagnostics);
	const rootRecons = /* @__PURE__ */ new Map();
	for (const page of preparedPages) {
		const rootTitle = aliasRule.rootByTitle.get(page.title) ?? page.title;
		if (rootTitle !== page.title) continue;
		const aliasesToApply = aliasRule.aliasesByRootTitle.get(rootTitle) ?? [page.title];
		if (page.isDaily) {
			rootRecons.set(rootTitle, {
				plannedId: page.blockId,
				finalId: page.blockId,
				page,
				merging: false,
				aliasRuleMerged: false,
				rootTitle,
				aliasesToApply
			});
			continue;
		}
		const existing = await lookupExistingPageByAliases(repo, workspaceId, aliasesToApply);
		rootRecons.set(rootTitle, {
			plannedId: page.blockId,
			finalId: existing?.id ?? page.blockId,
			page,
			merging: Boolean(existing),
			aliasRuleMerged: false,
			rootTitle,
			aliasesToApply
		});
	}
	const out = [];
	for (let i = 0; i < preparedPages.length; i++) {
		const page = preparedPages[i];
		const rootTitle = aliasRule.rootByTitle.get(page.title) ?? page.title;
		const rootRecon = rootRecons.get(rootTitle);
		if (!rootRecon) throw new Error(`reconcilePages: missing root reconciliation for ${rootTitle}`);
		if (rootTitle === page.title) out.push(rootRecon);
		else out.push({
			plannedId: page.blockId,
			finalId: rootRecon.finalId,
			page,
			merging: true,
			aliasRuleMerged: true,
			rootTitle,
			aliasesToApply: rootRecon.aliasesToApply
		});
		if (log && (i + 1) % 100 === 0 && i + 1 < preparedPages.length) log(`Reconciled ${i + 1}/${preparedPages.length} pages`);
	}
	return out;
};
var buildReparentMap = (recons) => {
	const map = /* @__PURE__ */ new Map();
	for (const r of recons) if (r.plannedId !== r.finalId) map.set(r.plannedId, r.finalId);
	return map;
};
var applyReparent = (data, reparent) => {
	if (!data.parentId) return data;
	const reparented = reparent.get(data.parentId);
	if (!reparented) return data;
	return {
		...data,
		parentId: reparented
	};
};
/**
* Pure planning step: build the alias → blockId map without writing
* anything. Daily-shaped aliases resolve via `dailyNoteBlockId`
* (deterministic; the row gets materialised lazily by
* `getOrCreateDailyNote`); existing blocks resolve via the now-indexed
* `findBlockByAliasInWorkspace`; everything else points at the
* indexed deterministic alias seat (`resolveAliasSeatId`) which the
* main import tx will materialise idempotently.
*
* Why not open per-alias txs anymore: a 5K-alias Roam export spawned
* 5K side-txs, each firing post-commit processors, row-events tail,
* handle invalidation, and (in production) one PowerSync upload
* round-trip. The deterministic-seat scheme matches what
* references.parseReferences produces, so the seats unify with any
* pre-existing typed `[[alias]]` stubs and the main-tx
* parseReferences post-commit becomes a no-op (planned references
* already match what the processor would compute).
*/
var resolveAliases = async (aliases, recons, repo, workspaceId, log) => {
	const aliasIdMap = /* @__PURE__ */ new Map();
	const aliasesNeedingSeat = [];
	const importedPagesByTitle = /* @__PURE__ */ new Map();
	for (const r of recons) {
		importedPagesByTitle.set(r.page.title, r.finalId);
		for (const alias of r.aliasesToApply) if (!importedPagesByTitle.has(alias)) importedPagesByTitle.set(alias, r.finalId);
	}
	const total = aliases.size;
	let processed = 0;
	for (const alias of aliases) {
		const importedHit = importedPagesByTitle.get(alias);
		if (importedHit) aliasIdMap.set(alias, importedHit);
		else {
			const parsedDate = parseLiteralDailyPageTitle(alias);
			if (parsedDate) aliasIdMap.set(alias, dailyNoteBlockId(workspaceId, parsedDate.iso));
			else {
				const existing = await repo.query.aliasLookup({
					workspaceId,
					alias
				}).load();
				if (existing) aliasIdMap.set(alias, existing.id);
				else {
					const id = await resolveAliasSeatId(aliasSeatReaderFromDb(repo.db), alias, workspaceId);
					aliasIdMap.set(alias, id);
					aliasesNeedingSeat.push(alias);
				}
			}
		}
		processed += 1;
		if (log && processed % 200 === 0 && processed < total) log(`Resolved ${processed}/${total} aliases`);
	}
	return {
		aliasIdMap,
		aliasesNeedingSeat
	};
};
var patchAliasReferences = (data, aliasIdMap) => {
	const parsed = parseRoamImportReferences(data.content);
	if (parsed.length === 0) return;
	const seen = new Set(data.references.map((r) => `${r.id}:${r.alias}`));
	for (const ref of parsed) {
		const id = aliasIdMap.get(ref.alias);
		if (!id) continue;
		const key = `${id}:${ref.alias}`;
		if (seen.has(key)) continue;
		seen.add(key);
		data.references.push({
			id,
			alias: ref.alias
		});
	}
};
/** Whether a tombstoned row is a genuinely pristine stub that is safe to
*  blank-restore as a placeholder. Pristine = empty content, no
*  references, NO properties at all (any property — even a cosmetic one
*  like collapse / show-properties — means a user touched this row), and
*  no children at all — live OR tombstoned. A container the user deleted
*  (which cascade-tombstones its whole subtree) still has child rows, so
*  counting deleted children keeps us from resurrecting + re-rooting that
*  container as a blank stub and thereby undoing the user's deletion.
*  Same spirit as the "restorable transient tombstone" test alias-seat
*  reuse applies in src/data/targets.ts (`isRestorableTransientTombstone`)
*  — empty seed + no children — but deliberately STRICTER on children:
*  that predicate ignores tombstoned children (live-only), whereas a Roam
*  placeholder id can collide with a real container the user deleted, so
*  here we also reject deleted children. Anything that is NOT pristine is
*  user data we must not resurrect or relocate (#195), so the placeholder
*  path leaves it tombstoned; an unresolved ((uid)) pointing at such a
*  tombstone is the correct, lossless state until a complete import
*  upserts the real block back via upsertImportedBlock. */
var isPristineRestorableStub = async (tx, row) => row.content === "" && row.references.length === 0 && Object.keys(row.properties).length === 0 && !await tx.hasChildren(row.id, { includeDeleted: true });
/**
* Ensure a placeholder row exists at `id`. Used for ((uid)) targets
* whose real block isn't in this export — references[] in imported
* content needs the row to be present so backlinks resolve. Branches:
*   - Fresh insert: write an empty stub at workspace root.
*   - Live-row hit: leave alone (a real block with content may
*     already live at this id; a placeholder must NOT clobber it).
*   - Tombstone hit, pristine stub: tx.restore to an empty placeholder
*     and move it to the workspace root so references resolve. "Pristine"
*     = empty content/references/properties and no children (live or
*     tombstoned) (see isPristineRestorableStub). The user can re-delete
*     after the import if they were intentionally cleaning up; leaving the
*     row tombstoned would crash the import tx.
*   - Tombstone hit, NOT pristine: the deleted row is user data — a real
*     block deleted under this uid (content / properties / backlinks), a
*     stub the user touched (e.g. collapsed → a stray property), or a
*     container the user deleted (whose subtree is cascade-tombstoned but
*     still present). Blank-restoring it would destroy that data, or undo
*     the deletion and relocate the container to the workspace root (#195).
*     Preserving live user data — including history — is paramount, so we
*     leave it tombstoned. A later, more-complete import that DOES include
*     the real block upserts it back via upsertImportedBlock; an
*     unresolved ((uid)) pointing at a tombstone is the correct, lossless
*     state until then.
*/
var ensurePlaceholderRow = async (tx, { id, workspaceId }) => {
	try {
		await tx.createOrGet({
			id,
			workspaceId,
			parentId: null,
			orderKey: "a0",
			content: ""
		});
	} catch (err) {
		if (!(err instanceof DeletedConflictError)) throw err;
		const existing = await tx.get(id);
		if (!existing || !await isPristineRestorableStub(tx, existing)) return;
		await tx.restore(id, {
			content: "",
			references: [],
			properties: {}
		});
		await tx.move(id, {
			parentId: null,
			orderKey: "a0"
		});
	}
};
var pageImportMergeOptions = () => ({
	sourceFields: PAGE_SOURCE_FIELDS,
	sourcePrefixes: ROAM_SOURCE_PREFIXES
});
var todoMappingFor = (desc) => desc.todoState ? TAG_TO_TYPE[desc.todoState] : void 0;
var mergeOptionsForDescendant = (desc) => {
	const mapping = todoMappingFor(desc);
	return {
		appOwnedFields: mapping ? Object.keys(mapping.appOwnedInit) : [],
		sourcePrefixes: ROAM_SOURCE_PREFIXES
	};
};
var ROAM_MEMO_SRS_CONFLICT_FIELDS = [
	srsIntervalProp.name,
	srsFactorProp.name,
	srsNextReviewDateProp.name,
	srsReviewCountProp.name,
	srsGradeProp.name,
	srsArchivedProp.name,
	srsSnapshotHistoryProp.name
];
var storedValuesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/**
* Rebuild a block's `references` from freshly projected property refs while
* honouring the add-only / retain-on-source contract
* (docs/contracts/derived-data-add-only.md). Content refs (empty
* `sourceField`) are kept verbatim — the importer doesn't re-parse content
* here — and `propertyRefs` is authoritative for every property whose schema
* is PRESENT. A prior property-derived ref whose schema is ABSENT can't be
* re-derived, so `reconcileDerived` RETAINS it (via `isRetainableAbsentRef`)
* rather than dropping it: an absent ref-typed schema at import time
* (`?safeMode`, a toggled-off plugin, a not-yet-republished UserSchemasService
* bucket) must not silently delete a property-derived backlink — the per-block
* drip of the same class that wiped ~10k SRS `next-review-date` backlinks.
*
* `after` is the block's post-write properties (the basis `propertyRefs` was
* projected from); `before` is the pre-write state used to confirm an absent
* field's value didn't change in this write (the one case where a stale
* absent-schema ref is allowed to drop). At the planner site there is no
* separate prior row, so `after === before`.
*/
var referencesWithProjectedProperties = (prior, propertyRefs, after, before, propertySchemas) => normalizeReferences(reconcileDerived({
	prior: prior ?? [],
	recomputed: [...propertyRefs],
	keyOf: derivedRefKey,
	retain: (ref) => (ref.sourceField ?? "") === "" || isRetainableAbsentRef(ref, after, before, propertySchemas)
}));
var formatStoredForDiagnostic = (value) => Array.isArray(value) ? `[${value.length} items]` : JSON.stringify(value);
var appendRoamMemoExistingConflicts = (diagnostics, desc, existing) => {
	if (!desc.roamMemo || !existing) return;
	const conflicts = [];
	for (const field of ROAM_MEMO_SRS_CONFLICT_FIELDS) {
		const planned = desc.data.properties[field];
		if (planned === void 0) continue;
		const current = existing.properties[field];
		if (current === void 0 || storedValuesEqual(current, planned)) continue;
		conflicts.push(`${field} existing=${formatStoredForDiagnostic(current)} memo=${formatStoredForDiagnostic(planned)}`);
	}
	if (conflicts.length === 0) return;
	diagnostics.push(`roam/memo SRS conflict on uid ${desc.roamUid}: ${conflicts.join(", ")}`);
};
var mergeImportedProperties = (existing, planned, options = {}) => {
	const appOwned = new Set(options.appOwnedFields ?? []);
	const sourceFields = new Set([...Object.keys(planned), ...options.sourceFields ?? []]);
	const sourcePrefixes = options.sourcePrefixes ?? [];
	for (const key of Object.keys(existing)) if (sourcePrefixes.some((prefix) => key.startsWith(prefix))) sourceFields.add(key);
	const keys = new Set([
		...Object.keys(existing),
		...Object.keys(planned),
		...sourceFields
	]);
	const next = {};
	for (const key of keys) {
		const existingHas = Object.hasOwn(existing, key);
		const plannedHas = Object.hasOwn(planned, key);
		if (appOwned.has(key)) {
			if (existingHas) next[key] = existing[key];
			else if (plannedHas) next[key] = planned[key];
			continue;
		}
		if (sourceFields.has(key)) {
			if (plannedHas) next[key] = planned[key];
			continue;
		}
		if (existingHas) next[key] = existing[key];
		else if (plannedHas) next[key] = planned[key];
	}
	return next;
};
var applyMappedTypesInTx = async (tx, desc, repo, typeSnapshot) => {
	const mapping = todoMappingFor(desc);
	if (mapping) {
		await repo.addTypeInTx(tx, desc.data.id, mapping.typeId, mapping.appOwnedInit, typeSnapshot);
		const roamTodoState = mapping.sourceMirror[roamTodoStateProp.name];
		if (roamTodoState) await tx.setProperty(desc.data.id, roamTodoStateProp, roamTodoState);
	}
	if (desc.srsSchedule || desc.roamMemo?.snapshots.length || desc.roamMemo?.archived) await repo.addTypeInTx(tx, desc.data.id, SRS_SM25_TYPE, {}, typeSnapshot);
};
/**
* Insert a planned block, OR upgrade an existing row at the same id.
*
* Three branches:
*   - Fresh insert (createOrGet returns inserted=true): nothing else
*     to do — the row was written with the planned data.
*   - Live-row hit (inserted=false): apply only changed planned
*     content / references / source-owned properties, then re-parent
*     only when parentId/orderKey differ so re-importing unchanged
*     rows doesn't emit metadata-only updates.
*   - Tombstone hit (createOrGet throws DeletedConflictError):
*     tx.restore writes deleted=0 + the data-field patch in one
*     UPDATE; tx.move handles parent_id + order_key. Without this
*     branch a re-import of a previously-deleted Roam block / page
*     would crash the entire import tx.
*
* Live-row content + references remain source-authoritative. Properties
* merge by ownership: planned/importer source fields refresh, app-owned
* type fields initialise only when missing, and unrelated local fields
* survive. Tombstones still resurrect with the planned data rather than
* the user's pre-deletion state.
*/
var upsertImportedBlock = async (tx, data, propertySchemas, propertyMergeOptions = {}) => {
	const references = normalizeReferences(data.references ?? []);
	const sourceTimestamps = data.createdAt !== void 0 && data.userUpdatedAt !== void 0 ? {
		createdAt: data.createdAt,
		userUpdatedAt: data.userUpdatedAt
	} : void 0;
	try {
		if ((await tx.createOrGet({
			id: data.id,
			workspaceId: data.workspaceId,
			parentId: data.parentId,
			orderKey: data.orderKey,
			content: data.content,
			properties: data.properties,
			references
		}, { sourceTimestamps })).inserted) return;
		const existing = await tx.get(data.id);
		if (!existing) throw new Error(`upsertImportedBlock: existing block ${data.id} not found`);
		const properties = mergeImportedProperties(existing.properties, data.properties ?? {}, propertyMergeOptions);
		const patch = {};
		if (existing.content !== data.content) patch.content = data.content;
		if (!storedValuesEqual(existing.properties, properties)) patch.properties = properties;
		const reconciledReferences = normalizeReferences(reconcileDerived({
			prior: existing.references,
			recomputed: references,
			keyOf: derivedRefKey,
			retain: (ref) => isRetainableAbsentRef(ref, { properties }, existing, propertySchemas)
		}));
		if (!storedValuesEqual(normalizeReferences(existing.references), reconciledReferences)) patch.references = reconciledReferences;
		if (patch.content !== void 0 || patch.properties !== void 0 || patch.references !== void 0) await tx.update(data.id, patch);
		if (existing.parentId !== data.parentId || existing.orderKey !== data.orderKey) await tx.move(data.id, {
			parentId: data.parentId,
			orderKey: data.orderKey
		});
	} catch (err) {
		if (!(err instanceof DeletedConflictError)) throw err;
		const tombstone = await tx.get(data.id);
		const restoredReferences = tombstone ? normalizeReferences(reconcileDerived({
			prior: tombstone.references,
			recomputed: references,
			keyOf: derivedRefKey,
			retain: (ref) => isRetainableAbsentRef(ref, { properties: data.properties ?? {} }, tombstone, propertySchemas)
		})) : references;
		await tx.restore(data.id, {
			content: data.content,
			properties: data.properties ?? {},
			references: restoredReferences
		});
		await tx.move(data.id, {
			parentId: data.parentId,
			orderKey: data.orderKey
		});
	}
};
/**
* Fold Roam page source properties onto the live page row with
* fill-if-missing semantics — an existing local value takes precedence
* over the imported one (matching the alias-union behavior in
* `mergeIntoExistingPage`).
*
* Used for daily and merging pages, where the row already exists
* before the import tx and the page-level `composeBlockData` path
* doesn't run. Non-daily, non-merging pages bake the same attrs
* into `pageData.properties` at planner time.
*/
var applyPromotedAttributes = async (tx, id, promoted, propertySchemas) => {
	const keys = Object.keys(promoted);
	if (keys.length === 0) return;
	const existing = await tx.get(id);
	if (!existing) return;
	let changed = false;
	const next = { ...existing.properties };
	for (const k of keys) if (next[k] === void 0) {
		next[k] = promoted[k];
		changed = true;
	}
	const references = referencesWithProjectedProperties(existing.references, projectPropertyReferences({
		...existing,
		properties: next
	}, propertySchemas), { properties: next }, existing, propertySchemas);
	const referencesChanged = !storedValuesEqual(normalizeReferences(existing.references), references);
	if (!changed && !referencesChanged) return;
	await tx.update(id, {
		...changed ? { properties: next } : {},
		...referencesChanged ? { references } : {}
	});
};
var withPageAliases = (data, aliases) => ({
	...data,
	properties: addBlockTypeToProperties({
		...data.properties ?? {},
		[aliasesProp.name]: aliasesProp.codec.encode(uniqueExactStrings(aliases))
	}, PAGE_TYPE)
});
var mergePageAliases = async (tx, id, aliasesToApply) => {
	const existing = await tx.get(id);
	if (!existing) return;
	const currentValue = existing.properties[aliasesProp.name];
	const current = Array.isArray(currentValue) ? currentValue.filter((v) => typeof v === "string") : [];
	const next = uniqueExactStrings([...current, ...aliasesToApply]);
	if (next.length === current.length && next.every((alias, index) => alias === current[index])) return;
	await tx.setProperty(id, aliasesProp, next);
};
var mergeIntoExistingPage = async (tx, recon, repo, typeSnapshot = repo.snapshotTypeRegistries()) => {
	if (!await tx.get(recon.finalId)) throw new Error(`mergeIntoExistingPage: existing page ${recon.finalId} not found`);
	await mergePageAliases(tx, recon.finalId, recon.aliasesToApply);
	await repo.addTypeInTx(tx, recon.finalId, PAGE_TYPE, {}, typeSnapshot);
};
//#endregion
export { importRoam };

//# sourceMappingURL=import.js.map