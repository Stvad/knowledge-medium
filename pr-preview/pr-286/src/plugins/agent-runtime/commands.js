import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp, extensionDescriptionProp, extensionNameProp, getBlockTypes, topLevelBlockIdProp } from "../../data/properties.js";
import { EXTENSION_TYPE, PAGE_TYPE } from "../../data/blockTypes.js";
import { keyAtEnd } from "../../data/orderKey.js";
import { applyToggle } from "../../facets/togglable.js";
import { actionsFacet, appEffectsFacet, appMountsFacet, blockRenderersFacet } from "../../extensions/core.js";
import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { BACKLINKS_FOR_BLOCK_QUERY } from "../backlinks/query.js";
import { formatRoamDate } from "../../utils/dailyPage.js";
import { dailyNoteBlockId } from "../daily-notes/dailyNotes.js";
import { GROUPED_BACKLINKS_FOR_BLOCK_QUERY } from "../grouped-backlinks/query.js";
import { parseRelativeDate } from "../../utils/relativeDate.js";
import { refreshAppRuntime } from "../../facets/runtimeEvents.js";
import { approveExtension, createCompileCache, revokeExtensionApproval } from "../../extensions/compileExtensionModule.js";
import { userExtensionToggle } from "../../extensions/extensionToggles.js";
import { dynamicExtensionsExtension } from "../../extensions/dynamicExtensions.js";
import { resolveAppRuntime } from "../../facets/resolveAppRuntime.js";
import { invokeAction } from "../../shortcuts/actionDispatch.js";
import { resolveBacklinksFilter } from "../backlinks/resolveFilter.js";
import { resolveGroupedBacklinksConfig } from "../grouped-backlinks/resolveConfig.js";
import { DATA_MODEL_GUIDE } from "./dataModelGuide.js";
import { runHealthCommand } from "./healthCommand.js";
import { readRuntimeActions } from "../../extensions/runtimeActions.js";
import { findExtensionBlock } from "../../extensions/extensionLookup.js";
import { lintExtensionSource } from "./extensionLint.js";
import { extensionsOverridesProp, extensionsPrefsType } from "../extensions-settings/config.js";
import { describeFacets, describeRuntime, describeRuntimeSummary, pingRuntime } from "./describeRuntime.js";
import React from "react";
import ReactDOM from "react-dom";
//#region src/plugins/agent-runtime/commands.ts
var agentExtensionsParentAlias = "Agent-installed extensions";
var isString = (value) => typeof value === "string";
var isRecord = (value) => typeof value === "object" && value !== null;
var isStringArray = (value) => Array.isArray(value) && value.every(isString);
var optionalStringArray = (value) => isStringArray(value) ? value : void 0;
var isBlockPosition = (value) => value === void 0 || value === "first" || value === "last" || typeof value === "number";
var isSqlMode = (value) => value === "all" || value === "get" || value === "optional" || value === "execute";
var requireString = (value, fieldName) => {
	if (!isString(value)) throw new Error(`${fieldName} must be a string`);
	return value;
};
var getParams = (value) => {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("params must be an array");
	return value;
};
var getPosition = (value) => {
	if (!isBlockPosition(value)) throw new Error("position must be \"first\", \"last\", or a number");
	return value;
};
var getBlockDataInput = (command) => {
	const data = isRecord(command.data) ? structuredClone(command.data) : {};
	if (command.content !== void 0) data.content = requireString(command.content, "content");
	if (command.properties !== void 0) {
		if (!isRecord(command.properties)) throw new Error("properties must be an object");
		data.properties = structuredClone(command.properties);
	}
	return data;
};
var runSql = async (repo, sql, params = [], mode = "all") => {
	if (mode === "get") return repo.db.get(sql, params);
	if (mode === "optional") return repo.db.getOptional(sql, params);
	if (mode === "execute") return repo.db.execute(sql, params);
	return repo.db.getAll(sql, params);
};
var serializeVerificationError = (blockId, error) => ({
	blockId,
	name: error.name,
	message: error.message
});
var isExtensionContribution = (source, blockId) => {
	if (typeof source !== "string") return false;
	const prefix = `block:${blockId}`;
	return source === prefix || source.startsWith(`${prefix}/`);
};
var verifyExtensionBlock = async (repo, context, blockId) => {
	const block = await repo.load(blockId);
	if (!block) throw new Error(`Extension block ${blockId} not found after install`);
	const errors = [];
	const verificationRuntime = await resolveAppRuntime(dynamicExtensionsExtension({
		repo: { query: { findExtensionBlocks: () => ({ load: async () => [block] }) } },
		workspaceId: block.workspaceId,
		safeMode: false,
		overrides: new Map([[block.id, true]]),
		verifyLiveSource: true,
		cache: createCompileCache(),
		errorReporter: (reportedBlockId, error) => {
			errors.push(serializeVerificationError(reportedBlockId, error));
		}
	}), {
		overrides: new Map([[block.id, true]]),
		context: {
			repo,
			workspaceId: repo.activeWorkspaceId,
			safeMode: context.safeMode,
			generation: "agent-runtime-install-verify"
		}
	});
	const renderersContribs = verificationRuntime.contributionsById(blockRenderersFacet.id);
	const appMountsContribs = verificationRuntime.contributionsById(appMountsFacet.id);
	const appEffectsContribs = verificationRuntime.contributionsById(appEffectsFacet.id);
	const filterToExtension = (contribs) => contribs.filter((c) => isExtensionContribution(c.source, blockId));
	const extensionRenderers = filterToExtension(renderersContribs);
	const extensionAppMounts = filterToExtension(appMountsContribs);
	const extensionAppEffects = filterToExtension(appEffectsContribs);
	const idOf = (value) => typeof value === "object" && value !== null && typeof value.id === "string" ? value.id : void 0;
	const warnings = lintExtensionSource(block.content ?? "");
	return {
		ok: errors.length === 0,
		errors,
		actions: verificationRuntime.read(actionsFacet).map((action) => ({
			id: action.id,
			description: action.description,
			context: action.context
		})),
		facets: describeFacets(verificationRuntime).map((facet) => ({
			id: facet.id,
			contributionCount: facet.contributionCount
		})),
		contributions: {
			renderers: extensionRenderers.map((c) => idOf(c.value)).filter((id) => Boolean(id)),
			appMounts: extensionAppMounts.map((c) => idOf(c.value)).filter((id) => Boolean(id)),
			appEffects: extensionAppEffects.map((c) => idOf(c.value)).filter((id) => Boolean(id))
		},
		...warnings.length > 0 ? { warnings } : {}
	};
};
var mapPosition = (position) => {
	if (position === void 0 || position === "last") return { kind: "last" };
	if (position === "first" || position === 0) return { kind: "first" };
	return { kind: "last" };
};
var createRuntimeBlock = async (repo, input = {}) => {
	const content = input.content ?? input.data?.content ?? "";
	const properties = input.properties ?? input.data?.properties;
	const explicitId = input.data?.id;
	const references = input.data?.references;
	if (input.parentId) {
		const id = await repo.mutate.createChild({
			parentId: input.parentId,
			content,
			properties,
			references,
			position: mapPosition(input.position),
			id: explicitId
		});
		return repo.load(id);
	}
	const workspaceId = input.data?.workspaceId ?? repo.activeWorkspaceId;
	if (!workspaceId) throw new Error("createBlock with no parentId requires an active workspace");
	const id = explicitId ?? crypto.randomUUID();
	await repo.tx(async (tx) => {
		await tx.create({
			id,
			workspaceId,
			parentId: null,
			orderKey: input.data?.orderKey ?? "a0",
			content,
			properties,
			references
		});
	}, {
		scope: ChangeScope.BlockDefault,
		description: "agent runtime create root block"
	});
	return repo.load(id);
};
var updateRuntimeBlock = async (repo, input) => {
	const before = await repo.load(input.id);
	if (!before) throw new Error(`updateBlock: block ${input.id} not found`);
	const nextProperties = input.properties === void 0 ? void 0 : input.replaceProperties ? structuredClone(input.properties) : {
		...before.properties,
		...structuredClone(input.properties)
	};
	await repo.tx(async (tx) => {
		await tx.update(input.id, {
			...input.content !== void 0 ? { content: input.content } : {},
			...nextProperties !== void 0 ? { properties: nextProperties } : {}
		});
	}, {
		scope: ChangeScope.BlockDefault,
		description: "agent runtime block update"
	});
	return repo.load(input.id);
};
var extensionBlockProperties = (existing, label, description) => {
	return {
		...existing ?? {},
		...label ? { [extensionNameProp.name]: extensionNameProp.codec.encode(label) } : {},
		...description !== null ? { [extensionDescriptionProp.name]: extensionDescriptionProp.codec.encode(description ?? "") } : {}
	};
};
var resolveWorkspaceId = (repo) => {
	if (repo.activeWorkspaceId) return repo.activeWorkspaceId;
	throw new Error("install-extension requires an active workspace");
};
var installRuntimeExtension = async (repo, input, context) => {
	const source = input.source.trimEnd();
	if (!source) throw new Error("install-extension requires non-empty source");
	const description = input.description === void 0 ? null : input.description;
	const label = input.label?.trim() || null;
	const workspaceId = resolveWorkspaceId(repo);
	const existing = input.id || label ? (await findExtensionBlock(repo, workspaceId, {
		id: input.id,
		label: label ?? void 0
	}))?.block ?? null : null;
	if (existing) {
		const typeSnapshot = repo.snapshotTypeRegistries();
		await repo.tx(async (tx) => {
			const current = await tx.get(existing.id);
			if (!current) throw new Error(`Extension block ${existing.id} disappeared before update`);
			const properties = extensionBlockProperties(current.properties, label, description);
			await tx.update(existing.id, {
				content: source,
				properties
			});
			await repo.addTypeInTx(tx, existing.id, EXTENSION_TYPE, {}, typeSnapshot);
		}, {
			scope: ChangeScope.BlockDefault,
			description: `agent runtime install extension ${label ?? existing.id}`
		});
		const verification = input.verify ? await verifyExtensionBlock(repo, context, existing.id) : void 0;
		const reloaded = input.reload !== false;
		if (reloaded) refreshAppRuntime();
		return {
			id: existing.id,
			inserted: false,
			label,
			reloaded,
			...verification ? { verification } : {}
		};
	}
	const parentIdFromInput = input.parentId?.trim() || null;
	const defaultParent = parentIdFromInput ? null : await repo.query.aliasLookup({
		workspaceId,
		alias: agentExtensionsParentAlias
	}).load();
	let installedId = input.id?.trim() || "";
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		let rootId = parentIdFromInput ?? defaultParent?.id ?? null;
		if (!rootId) {
			const rootSiblings = await tx.childrenOf(null, workspaceId);
			rootId = await tx.create({
				workspaceId,
				parentId: null,
				orderKey: keyAtEnd(rootSiblings.at(-1)?.orderKey ?? null),
				content: agentExtensionsParentAlias
			});
			await repo.addTypeInTx(tx, rootId, PAGE_TYPE, { [aliasesProp.name]: [agentExtensionsParentAlias] }, typeSnapshot);
		}
		let parentId = rootId;
		if (label && !parentIdFromInput) {
			const rootChildren = await tx.childrenOf(rootId, workspaceId);
			const existingContainer = rootChildren.find((child) => child.content === label && !child.deleted);
			if (existingContainer) parentId = existingContainer.id;
			else {
				parentId = await tx.create({
					workspaceId,
					parentId: rootId,
					orderKey: keyAtEnd(rootChildren.at(-1)?.orderKey ?? null),
					content: label
				});
				await repo.addTypeInTx(tx, parentId, PAGE_TYPE, {}, typeSnapshot);
			}
		}
		const siblings = await tx.childrenOf(parentId, workspaceId);
		const properties = extensionBlockProperties(void 0, label, description);
		installedId = await tx.create({
			id: installedId || void 0,
			workspaceId,
			parentId,
			orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
			content: source,
			properties
		});
		await repo.addTypeInTx(tx, installedId, EXTENSION_TYPE, {}, typeSnapshot);
	}, {
		scope: ChangeScope.BlockDefault,
		description: `agent runtime install extension ${label ?? "unnamed"}`
	});
	const verification = input.verify ? await verifyExtensionBlock(repo, context, installedId) : void 0;
	const reloaded = input.reload !== false;
	if (reloaded) refreshAppRuntime();
	return {
		id: installedId,
		inserted: true,
		label,
		reloaded,
		...verification ? { verification } : {}
	};
};
var setExtensionEnabled = async (repo, input) => {
	const workspaceId = resolveWorkspaceId(repo);
	if (!input.id?.trim() && !input.label?.trim()) throw new Error("set-extension-enabled requires `id` or `label`");
	const found = await findExtensionBlock(repo, workspaceId, input);
	if (!found) throw new Error(`No installed extension matches "${input.id ?? input.label}"`);
	if (input.enabled) await approveExtension(found.block.id, found.block.content ?? "");
	const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, extensionsPrefsType);
	const current = prefsBlock.peekProperty(extensionsOverridesProp) ?? /* @__PURE__ */ new Map();
	const next = applyToggle(current, userExtensionToggle(found.block), input.enabled);
	const changed = next.size !== current.size || [...next.entries()].some(([id, value]) => current.get(id) !== value);
	if (changed) await prefsBlock.set(extensionsOverridesProp, next);
	if (input.enabled && !changed) refreshAppRuntime();
	return {
		id: found.block.id,
		label: found.label,
		enabled: input.enabled,
		changed
	};
};
var uninstallRuntimeExtension = async (repo, input) => {
	const workspaceId = resolveWorkspaceId(repo);
	if (!input.id?.trim() && !input.label?.trim()) throw new Error("uninstall-extension requires `id` or `label`");
	const found = await findExtensionBlock(repo, workspaceId, input);
	if (!found) throw new Error(`No installed extension matches "${input.id ?? input.label}"`);
	await repo.tx(async (tx) => {
		await tx.delete(found.block.id);
	}, {
		scope: ChangeScope.BlockDefault,
		description: `agent runtime uninstall extension ${found.label ?? found.block.id}`
	});
	await revokeExtensionApproval(found.block.id);
	refreshAppRuntime();
	return {
		id: found.block.id,
		label: found.label,
		removed: true
	};
};
var isActionDependenciesInput = (value) => value === void 0 || isRecord(value);
var fakeUiStateBlock = (repo) => ({ repo });
var runtimeBlock = (repo, id) => isString(id) && id ? repo.block(id) : null;
var runRuntimeAction = async (command, context) => {
	const actionId = requireString(command.id ?? command.actionId, "actionId");
	const action = context.actions.find((candidate) => candidate.id === actionId);
	if (!action) throw new Error(`Action not found: ${actionId}`);
	if (!isActionDependenciesInput(command.dependencies)) throw new Error("dependencies must be an object");
	const dependencies = command.dependencies ?? {};
	const realUiStateBlock = runtimeBlock(context.repo, dependencies.uiStateBlockId) ?? runtimeBlock(context.repo, command.uiStateBlockId);
	const uiStateBlock = realUiStateBlock ?? fakeUiStateBlock(context.repo);
	const block = runtimeBlock(context.repo, dependencies.blockId) ?? runtimeBlock(context.repo, command.blockId) ?? uiStateBlock;
	if (action.context === "edit-mode-cm" || action.context === "property-editing") throw new Error(`Action ${action.id} runs in ${action.context}; bridge run-action cannot provide editor/input UI dependencies`);
	const deps = {
		uiStateBlock,
		block,
		selectedBlocks: (Array.isArray(dependencies.selectedBlockIds) ? dependencies.selectedBlockIds.filter(isString) : []).map((id) => context.repo.block(id)),
		anchorBlock: runtimeBlock(context.repo, dependencies.anchorBlockId),
		scopeRootId: isString(dependencies.scopeRootId) ? dependencies.scopeRootId : realUiStateBlock?.peekProperty(topLevelBlockIdProp)
	};
	const trigger = new CustomEvent("agent-runtime:run-action", { detail: { actionId } });
	let returned;
	try {
		returned = await invokeAction(context.runtime, {
			action,
			deps,
			trigger
		});
	} catch (handlerError) {
		const prefix = `Action ${action.id} (${action.context}) threw: `;
		if (handlerError instanceof Error) {
			handlerError.message = `${prefix}${handlerError.message}`;
			throw handlerError;
		}
		throw new Error(`${prefix}${String(handlerError)}`, { cause: handlerError });
	}
	return {
		id: action.id,
		description: action.description,
		context: action.context,
		ok: true,
		returnedUndefined: returned === void 0,
		returned: returned === void 0 ? null : returned
	};
};
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var deepLinkFor = (workspaceId, blockId) => `#${workspaceId}/${blockId}`;
var HYDRATE_BLOCK_REFS_SQL = `
  SELECT b.id AS id, b.content AS content,
         b.properties_json AS properties_json, b.workspace_id AS workspace_id
  FROM json_each(?) j
  JOIN blocks b ON b.id = j.value
  WHERE b.deleted = 0
`;
/** Hydrate a list of block ids into {id, content, types, deepLink},
*  preserving the input order. One JSON-array bind regardless of count
*  (avoids the SQLite parameter ceiling on heavily-linked targets). */
var hydrateBlockRefs = async (repo, fallbackWorkspaceId, ids) => {
	if (ids.length === 0) return [];
	const rows = await repo.db.getAll(HYDRATE_BLOCK_REFS_SQL, [JSON.stringify(ids)]);
	const byId = new Map(rows.map((row) => [row.id, row]));
	return ids.map((id) => {
		const row = byId.get(id);
		let types = [];
		if (row?.properties_json) try {
			types = [...getBlockTypes({ properties: JSON.parse(row.properties_json) })];
		} catch {
			types = [];
		}
		return {
			id,
			content: row?.content ?? "",
			types,
			deepLink: deepLinkFor(row?.workspace_id ?? fallbackWorkspaceId, id)
		};
	});
};
var SOURCE_FIELDS_SQL = `
  SELECT DISTINCT source_id, source_field
  FROM block_references
  WHERE workspace_id = ? AND target_id = ?
`;
/** Map each backlink source to the set of source_fields it referenced the
*  target through. `''` means a plain text wikilink; other values are
*  projected property refs (groupWith, next-review-date, …). */
var sourceFieldsByBacklink = async (repo, workspaceId, targetId) => {
	const rows = await repo.db.getAll(SOURCE_FIELDS_SQL, [workspaceId, targetId]);
	const out = /* @__PURE__ */ new Map();
	for (const row of rows) {
		let set = out.get(row.source_id);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			out.set(row.source_id, set);
		}
		set.add(row.source_field);
	}
	return new Map([...out].map(([id, set]) => [id, [...set].sort()]));
};
var resolveBlockWorkspaceId = async (repo, blockId, override) => {
	if (isString(override) && override) return override;
	const data = await repo.load(blockId);
	if (data?.workspaceId) return data.workspaceId;
	if (repo.activeWorkspaceId) return repo.activeWorkspaceId;
	throw new Error(`Cannot resolve a workspace for block ${blockId}; pass workspaceId`);
};
var parseFilterSpec = (value) => {
	if (value === void 0) return void 0;
	if (value === "none" || value === "stored" || value === "effective") return value;
	if (isRecord(value)) return value;
	throw new Error("filter must be 'none' | 'stored' | 'effective' or a BacklinksFilter object");
};
var parseGroupingSpec = (value) => {
	if (value === void 0) return void 0;
	if (value === "user" || value === "none") return value;
	if (isRecord(value)) return value;
	throw new Error("grouping must be 'user' | 'none' or a grouping-config object");
};
var runBacklinksCommand = async (repo, command) => {
	const id = requireString(command.blockId ?? command.id, "blockId");
	const workspaceId = await resolveBlockWorkspaceId(repo, id, command.workspaceId);
	const filter = await resolveBacklinksFilter(repo, workspaceId, id, parseFilterSpec(command.filter));
	const ids = await repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
		workspaceId,
		id,
		...filter ? { filter } : {}
	}).load();
	const [hydrated, fieldsBySource, [target]] = await Promise.all([
		hydrateBlockRefs(repo, workspaceId, ids),
		sourceFieldsByBacklink(repo, workspaceId, id),
		hydrateBlockRefs(repo, workspaceId, [id])
	]);
	return {
		target,
		workspaceId,
		total: ids.length,
		filter: filter ?? null,
		backlinks: hydrated.map((ref) => ({
			...ref,
			sourceFields: fieldsBySource.get(ref.id) ?? []
		}))
	};
};
var runGroupedBacklinksCommand = async (repo, command) => {
	const id = requireString(command.blockId ?? command.id, "blockId");
	const workspaceId = await resolveBlockWorkspaceId(repo, id, command.workspaceId);
	const filter = await resolveBacklinksFilter(repo, workspaceId, id, parseFilterSpec(command.filter));
	const grouping = await resolveGroupedBacklinksConfig(repo, workspaceId, id, parseGroupingSpec(command.grouping));
	const result = await repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
		workspaceId,
		id,
		groupingConfig: grouping,
		...filter ? { filter } : {}
	}).load();
	const memberIds = [...new Set(result.groups.flatMap((group) => group.sourceIds))];
	const [members, [target]] = await Promise.all([hydrateBlockRefs(repo, workspaceId, memberIds), hydrateBlockRefs(repo, workspaceId, [id])]);
	const memberById = new Map(members.map((member) => [member.id, member]));
	return {
		target,
		workspaceId,
		total: result.total,
		filter: filter ?? null,
		grouping,
		groups: result.groups.map((group) => ({
			groupId: group.groupId,
			label: group.label,
			fallback: group.fallback,
			deepLink: UUID_RE.test(group.groupId) ? deepLinkFor(workspaceId, group.groupId) : null,
			members: group.sourceIds.map((sourceId) => memberById.get(sourceId) ?? {
				id: sourceId,
				content: "",
				types: [],
				deepLink: deepLinkFor(workspaceId, sourceId)
			})
		}))
	};
};
var hydrateData = (data) => ({
	id: data.id,
	content: data.content ?? "",
	types: [...getBlockTypes(data)],
	deepLink: deepLinkFor(data.workspaceId, data.id)
});
var commandWorkspaceId = (repo, override) => {
	if (isString(override) && override) return override;
	if (repo.activeWorkspaceId) return repo.activeWorkspaceId;
	throw new Error("No active workspace; pass workspaceId");
};
var runPageCommand = async (repo, command) => {
	const name = requireString(command.name, "name");
	const workspaceId = commandWorkspaceId(repo, command.workspaceId);
	const limit = typeof command.limit === "number" ? command.limit : 20;
	const exact = await repo.query.aliasLookup({
		workspaceId,
		alias: name
	}).load();
	const candidates = await repo.query.aliasMatches({
		workspaceId,
		filter: name,
		limit
	}).load();
	return {
		query: name,
		workspaceId,
		match: exact ? hydrateData(exact) : null,
		candidates: candidates.map((row) => ({
			id: row.blockId,
			alias: row.alias,
			content: row.content,
			deepLink: deepLinkFor(workspaceId, row.blockId)
		}))
	};
};
var runDailyNoteCommand = async (repo, command) => {
	const input = requireString(command.date, "date");
	const workspaceId = commandWorkspaceId(repo, command.workspaceId);
	const parsed = parseRelativeDate(input);
	if (!parsed) throw new Error(`Could not parse "${input}" as a date. Try today | yesterday | 2026-06-18 | "June 17th, 2026" | "next monday".`);
	const blockId = dailyNoteBlockId(workspaceId, parsed.iso);
	const data = await repo.load(blockId);
	return {
		input,
		iso: parsed.iso,
		title: formatRoamDate(parsed.date),
		workspaceId,
		blockId,
		exists: data !== null,
		deepLink: deepLinkFor(workspaceId, blockId),
		block: data ? hydrateData(data) : null
	};
};
var runSearchCommand = async (repo, command) => {
	const query = requireString(command.query, "query");
	const workspaceId = commandWorkspaceId(repo, command.workspaceId);
	const limit = typeof command.limit === "number" ? command.limit : 50;
	const rows = await repo.query.searchByContent({
		workspaceId,
		query,
		limit
	}).load();
	return {
		query,
		workspaceId,
		total: rows.length,
		results: rows.map(hydrateData)
	};
};
var executeArbitraryCode = async (code, context, data) => {
	const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
	return new AsyncFunction("ctx", "data", `
const {
  repo,
  db,
  runtime,
  safeMode,
  sql,
  block,
  getBlock,
  getSubtree,
  createBlock,
  updateBlock,
  installExtension,
  setExtensionEnabled,
  uninstallExtension,
  actions,
  renderers,
  refreshAppRuntime,
  React,
  ReactDOM,
  window,
  document,
} = ctx

return await (async () => {
${code}
})()
`)(context, data);
};
var createAgentRuntimeContext = ({ repo, runtime, safeMode }) => {
	const context = {
		repo,
		db: repo.db,
		runtime,
		safeMode,
		sql: (sql, params, mode) => runSql(repo, sql, params, mode),
		block: (id) => repo.block(id),
		getBlock: (id) => repo.load(id),
		getSubtree: async (rootId) => await repo.query.subtree({ id: rootId }).load(),
		createBlock: (input) => createRuntimeBlock(repo, input),
		updateBlock: (input) => updateRuntimeBlock(repo, input),
		installExtension: (input) => installRuntimeExtension(repo, input, context),
		setExtensionEnabled: (input) => setExtensionEnabled(repo, input),
		uninstallExtension: (input) => uninstallRuntimeExtension(repo, input),
		actions: readRuntimeActions(runtime),
		renderers: runtime.read(blockRenderersFacet),
		refreshAppRuntime,
		React,
		ReactDOM,
		window,
		document
	};
	return context;
};
var executeCommand = async (command, context) => {
	switch (command.type) {
		case "ping": return pingRuntime(context);
		case "runtime-summary": return describeRuntimeSummary(context);
		case "health": return runHealthCommand(context.repo);
		case "describe-runtime": return describeRuntime(context, {
			actions: isStringArray(command.actions) ? command.actions : void 0,
			facets: isStringArray(command.facets) ? command.facets : void 0,
			guides: optionalStringArray(command.guides ?? command.guide),
			modules: optionalStringArray(command.modules),
			components: optionalStringArray(command.components),
			storage: command.storage === true,
			brief: command.brief === true
		});
		case "sql": {
			const sql = requireString(command.sql, "sql");
			const mode = command.mode === void 0 ? "all" : isSqlMode(command.mode) ? command.mode : void 0;
			if (!mode) throw new Error("mode must be one of: all, get, optional, execute");
			return context.sql(sql, getParams(command.params), mode);
		}
		case "get-block": return context.getBlock(requireString(command.blockId ?? command.id, "blockId"));
		case "get-subtree": return context.getSubtree(requireString(command.rootId, "rootId"));
		case "create-block": return context.createBlock({
			parentId: command.parentId === void 0 ? void 0 : requireString(command.parentId, "parentId"),
			position: getPosition(command.position),
			data: getBlockDataInput(command)
		});
		case "update-block": {
			const properties = command.properties === void 0 ? void 0 : isRecord(command.properties) ? structuredClone(command.properties) : void 0;
			if (command.properties !== void 0 && !properties) throw new Error("properties must be an object");
			if (command.childIds !== void 0) {
				if (!isStringArray(command.childIds)) throw new Error("childIds must be an array of strings");
				throw new Error("childIds replacement is no longer supported by update-block; use repo.mutate.move per child instead");
			}
			return context.updateBlock({
				id: requireString(command.blockId ?? command.id, "blockId"),
				content: command.content === void 0 ? void 0 : requireString(command.content, "content"),
				properties,
				replaceProperties: Boolean(command.replaceProperties)
			});
		}
		case "install-extension": return context.installExtension({
			source: requireString(command.source, "source"),
			label: command.label === void 0 ? void 0 : requireString(command.label, "label"),
			description: command.description === void 0 ? void 0 : requireString(command.description, "description"),
			parentId: command.parentId === void 0 ? void 0 : requireString(command.parentId, "parentId"),
			id: command.id === void 0 ? void 0 : requireString(command.id, "id"),
			reload: command.reload === void 0 ? void 0 : Boolean(command.reload),
			verify: command.verify === void 0 ? void 0 : Boolean(command.verify)
		});
		case "set-extension-enabled":
		case "enable-extension":
		case "disable-extension": return context.setExtensionEnabled({
			id: command.id === void 0 ? void 0 : requireString(command.id, "id"),
			label: command.label === void 0 ? void 0 : requireString(command.label, "label"),
			enabled: command.type === "disable-extension" ? false : command.type === "enable-extension" ? true : Boolean(command.enabled)
		});
		case "uninstall-extension": return context.uninstallExtension({
			id: command.id === void 0 ? void 0 : requireString(command.id, "id"),
			label: command.label === void 0 ? void 0 : requireString(command.label, "label")
		});
		case "run-action":
		case "action": return runRuntimeAction(command, context);
		case "eval": return executeArbitraryCode(requireString(command.code, "code"), context, command.data);
		case "backlinks": return runBacklinksCommand(context.repo, command);
		case "grouped-backlinks": return runGroupedBacklinksCommand(context.repo, command);
		case "data-model": return DATA_MODEL_GUIDE;
		case "page": return runPageCommand(context.repo, command);
		case "daily-note": return runDailyNoteCommand(context.repo, command);
		case "search": return runSearchCommand(context.repo, command);
		default: throw new Error(`Unknown agent runtime command: ${command.type}`);
	}
};
//#endregion
export { createAgentRuntimeContext, executeCommand };

//# sourceMappingURL=commands.js.map