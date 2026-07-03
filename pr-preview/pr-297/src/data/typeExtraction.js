import { ChangeScope } from "./api/changeScope.js";
import "./api/index.js";
import { blockTypeColorProp, blockTypeLabelProp, blockTypePropertiesProp, hasBlockType, propertyNameProp } from "./properties.js";
import { BLOCK_TYPE_TYPE, PAGE_TYPE, PROPERTY_SCHEMA_TYPE } from "./blockTypes.js";
import { typesPageBlockId } from "./typesPage.js";
import { createChild } from "./mutators.js";
import { pickLeastUsedTypeColor } from "./typeColors.js";
//#region src/data/typeExtraction.ts
/** Extract-type-from-prototype primitives.
*
*  Three operations user-defined-types Phase 3 composes through:
*
*  1. `createTypeBlock(repo, args)` — materialize a fresh
*     `block-type` block on the workspace's Types page with the
*     caller's label + property-schema refList, then wait for
*     `UserTypesService` to publish the contribution into the
*     `typesFacet` user-data bucket. Returns the new block id, which
*     IS the type id (the user-defined-types block-id = type-id rule).
*
*  2. `retagBlocks(repo, args)` — apply a type to an explicit list of
*     block ids inside a single tx. Strict per-row existence checks
*     (skips rows that were deleted or moved between caller's query
*     and the tx open).
*
*  3. `findCandidatesByPropertyShape(repo, args)` — query primitive
*     for "blocks whose properties bag carries this subset of
*     property names, optionally constrained to specific values."
*     Built on top of `repo.queryBlocks` — no new index needed.
*
*  The user-facing "Extract type from this block" flow composes these
*  three: the caller (UI) picks the property subset off the prototype,
*  calls `createTypeBlock` to materialize a fresh definition, calls
*  `findCandidatesByPropertyShape` to surface a candidate list, and
*  finally calls `retagBlocks` with the user-confirmed instance ids.
*  The orchestration deliberately stays in the UI layer — the
*  candidate confirmation step is heuristic and the user is the
*  arbiter, so wrapping the three into a single function would force
*  every caller through the same confirmation shape. */
/** Thrown by `createTypeBlock`'s Phase A→bridge handoff when the
*  `UserTypesService` subscription doesn't publish the new id into
*  `typesFacet`'s user-data bucket within `registrationTimeoutMs`.
*  Realistic cause: `tryBuildType` returned null (the block-type
*  block failed to parse — e.g. a property-schema ref doesn't
*  resolve in the live registry). */
var TypeRegistrationTimeout = class extends Error {
	constructor(typeBlockId, typeLabel, timeoutMs) {
		super(`createTypeBlock: type-definition block for "${typeLabel}" was committed but did not appear in the runtime registry within ${timeoutMs}ms. Likely cause: UserTypesService.tryBuildType rejected the block (e.g. a referenced property-schema id doesn't resolve in the live registry, or the workspace bucket hasn't reset since the last switch).`);
		this.typeBlockId = typeBlockId;
		this.typeLabel = typeLabel;
		this.timeoutMs = timeoutMs;
		this.name = "TypeRegistrationTimeout";
	}
};
/** Create a fresh `block-type` block on the workspace's Types page.
*  Returns the new block id (== type id once registered). The
*  returned id is in the live `repo.types` registry by the time the
*  promise resolves. */
async function createTypeBlock(repo, args) {
	args.signal?.throwIfAborted();
	const trimmedLabel = args.label.trim();
	if (trimmedLabel === "") throw new Error(`createTypeBlock: label must be a non-empty string (got ${JSON.stringify(args.label)}). UserTypesService.tryBuildType silently drops a block-type block with an empty label.`);
	const typesPageId = typesPageBlockId(args.workspaceId);
	const typesPage = await repo.load(typesPageId);
	if (!typesPage || typesPage.workspaceId !== args.workspaceId) throw new Error(`createTypeBlock: no Types page for workspace ${args.workspaceId}. Call getOrCreateTypesPage during workspace bootstrap.`);
	for (const schemaId of args.propertySchemaIds) {
		const schemaBlock = await repo.load(schemaId);
		if (!schemaBlock) throw new Error(`createTypeBlock: property-schema ref ${schemaId} doesn't resolve to a live block. Drop it before retrying.`);
		if (schemaBlock.workspaceId !== args.workspaceId) throw new Error(`createTypeBlock: property-schema ref ${schemaId} is in workspace ${schemaBlock.workspaceId} but the new type is in ${args.workspaceId}. Cross-workspace property-schema refs aren't supported.`);
		if (!hasBlockType(schemaBlock, "property-schema")) throw new Error(`createTypeBlock: ref ${schemaId} is not a property-schema block (missing the ${PROPERTY_SCHEMA_TYPE} type tag).`);
		const rawName = schemaBlock.properties[propertyNameProp.name];
		const name = typeof rawName === "string" ? rawName : "";
		if (name.trim() === "") throw new Error(`createTypeBlock: property-schema block ${schemaId} has empty ${propertyNameProp.name}; tryBuildType would silently drop it.`);
		if (!repo.userSchemas.getSchemaForBlockId(schemaId)) throw new Error(`createTypeBlock: property-schema block ${schemaId} ("${name}") isn't published by UserSchemasService — e.g. its preset isn't loaded, its config didn't validate, or the block hasn't synced yet. Fix the schema block before retrying.`);
	}
	args.signal?.throwIfAborted();
	const color = args.color !== void 0 ? args.color.trim() : args.workspaceId === repo.activeWorkspaceId ? pickLeastUsedTypeColor(repo.types.values()) : "";
	const typeSnapshot = repo.snapshotTypeRegistries();
	let newId = "";
	await repo.tx(async (tx) => {
		for (const schemaId of args.propertySchemaIds) {
			const row = await tx.get(schemaId);
			if (!row || row.deleted) throw new Error(`createTypeBlock: schema block ${schemaId} no longer exists`);
			if (row.workspaceId !== args.workspaceId) throw new Error(`createTypeBlock: schema block ${schemaId} moved to a different workspace`);
			if (!hasBlockType(row, "property-schema")) throw new Error(`createTypeBlock: schema block ${schemaId} no longer carries ${PROPERTY_SCHEMA_TYPE}`);
		}
		newId = await tx.run(createChild, {
			parentId: typesPageId,
			content: trimmedLabel
		});
		await repo.addTypeInTx(tx, newId, BLOCK_TYPE_TYPE, {}, typeSnapshot);
		await repo.addTypeInTx(tx, newId, PAGE_TYPE, {}, typeSnapshot);
		await tx.setProperty(newId, blockTypeLabelProp, trimmedLabel);
		await tx.setProperty(newId, blockTypePropertiesProp, args.propertySchemaIds);
		if (color) await tx.setProperty(newId, blockTypeColorProp, color);
	}, {
		scope: ChangeScope.BlockDefault,
		description: `createTypeBlock ${trimmedLabel}`
	});
	await waitForTypeRegistrationBounded(repo, newId, trimmedLabel, args.signal, args.registrationTimeoutMs ?? 1e4);
	return newId;
}
/** Apply `typeId` to every block in `instanceIds` in a single tx.
*  Idempotent per row: `addTypeInTx` no-ops when the type is already
*  present. Throws if `typeId` isn't registered. */
async function retagBlocks(repo, args) {
	args.signal?.throwIfAborted();
	if (!repo.types.has(args.typeId)) throw new Error(`retagBlocks: type ${args.typeId} is not registered. Call createTypeBlock first or verify the type-definition block hasn't been deleted.`);
	if (args.instanceIds.length === 0) return;
	await repo.tx(async (tx) => {
		const snapshotInTx = repo.snapshotTypeRegistries();
		if (!snapshotInTx.types.has(args.typeId)) throw new Error(`retagBlocks: type ${args.typeId} was unregistered between caller check and tx open — likely a sync-applied delete of the type-definition block.`);
		const typeRow = await tx.get(args.typeId);
		if (!typeRow || typeRow.deleted) throw new Error(`retagBlocks: type-definition block ${args.typeId} doesn't exist or was deleted inside the tx.`);
		const typeWorkspaceId = typeRow.workspaceId;
		for (const instanceId of args.instanceIds) {
			const row = await tx.get(instanceId);
			if (!row || row.deleted) continue;
			if (row.workspaceId !== typeWorkspaceId) continue;
			await repo.addTypeInTx(tx, instanceId, args.typeId, {}, snapshotInTx);
		}
	}, {
		scope: ChangeScope.BlockDefault,
		description: `retagBlocks ${args.typeId}`
	});
}
/** Find blocks whose property bag carries every name in `shape`,
*  optionally constrained by per-property equality / ref-target
*  filters. Returns block ids (not full `BlockData`) — callers that
*  need the rows can load them via `repo.load`.
*
*  Filter semantics (per `PropertyShapeFilter`):
*   - `value === undefined && (!targetIds || targetIds.length === 0)`:
*     presence-only via `where: {[name]: {exists: true}}`.
*   - `value` set: scalar equality via `where: {[name]: value}`.
*   - `targetIds` non-empty: permissive ref / refList match — compiles
*     to one `match` predicate per id with `referencedBy: {id,
*     sourceField: name}`. ANDing these means the candidate's ref(List)
*     at `name` must be a superset of `targetIds` (block can have
*     additional refs). */
async function findCandidatesByPropertyShape(repo, args) {
	if (args.shape.length === 0) return [];
	const where = {};
	const match = [];
	for (const filter of args.shape) {
		const targetIds = filter.targetIds ?? [];
		if (targetIds.length > 0) {
			for (const id of targetIds) match.push({ referencedBy: {
				id,
				sourceField: filter.name
			} });
			continue;
		}
		where[filter.name] = filter.value === void 0 ? { exists: true } : filter.value;
	}
	const rows = await repo.queryBlocks({
		workspaceId: args.workspaceId,
		where: Object.keys(where).length === 0 ? void 0 : where,
		match: match.length === 0 ? void 0 : match
	});
	const excluded = new Set(args.exclude ?? []);
	const limit = args.limit ?? 1e3;
	const out = [];
	for (const row of rows) {
		if (excluded.has(row.id)) continue;
		out.push(row.id);
		if (out.length >= limit) break;
	}
	return out;
}
async function waitForTypeRegistrationBounded(repo, typeId, typeLabel, signal, timeoutMs) {
	if (repo.types.has(typeId)) return;
	if (signal?.aborted) throw signal.reason;
	await new Promise((resolve, reject) => {
		let settled = false;
		const timerRef = { handle: null };
		const dispose = repo.onTypesChange(() => {
			if (repo.types.has(typeId)) settle(resolve);
		});
		const onAbort = () => settle(() => reject(signal.reason));
		const settle = (cb) => {
			if (settled) return;
			settled = true;
			if (timerRef.handle !== null) clearTimeout(timerRef.handle);
			dispose();
			signal?.removeEventListener("abort", onAbort);
			cb();
		};
		if (repo.types.has(typeId)) {
			settle(resolve);
			return;
		}
		timerRef.handle = setTimeout(() => settle(() => reject(new TypeRegistrationTimeout(typeId, typeLabel, timeoutMs))), timeoutMs);
		signal?.addEventListener("abort", onAbort);
		if (signal?.aborted) settle(() => reject(signal.reason));
	});
}
//#endregion
export { TypeRegistrationTimeout, createTypeBlock, findCandidatesByPropertyShape, retagBlocks };

//# sourceMappingURL=typeExtraction.js.map