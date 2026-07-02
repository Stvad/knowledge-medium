import { ChangeScope } from "./api/changeScope.js";
import "./api/index.js";
import { presetConfigProp, presetIdProp, propertyNameProp } from "./properties.js";
import { propertySchemasFacet } from "./facets.js";
import { PROPERTY_SCHEMA_TYPE } from "./blockTypes.js";
//#region src/data/userSchemasService.ts
/** User-defined `'property-schema'` blocks → the `propertySchemasFacet`
*  `'user-data'` runtime-contribution bucket. See
*  user-defined-properties.md §5 + §7.
*
*  The reactive lifecycle (subscribe / pin / publish / reset+clear on
*  dispose) lives in the shared `ProjectorRuntime` core, configured by
*  `userSchemasProjector` below. This file keeps only the schema-side
*  specifics: the builder (`tryBuildSchema`, which needs `valuePresets`)
*  and the distinct public surface — `addSchema` / `appendUserSchema`
*  and the `getSchemaBlockId` / `getSchemaForBlockId` lookups. */
/** Projector id for the user-defined property-schema bridge. */
var USER_SCHEMAS_PROJECTOR_ID = "user-schemas";
var USER_DATA_SOURCE_ID = "user-data";
/** Decode a single property straight off a raw row — same logic as
*  `Block.peekProperty`, minus the cache-backed facade. The block
*  subscription already hands us the authoritative `BlockData`, so
*  reading it directly avoids the hydration race where `repo.block(id)`
*  could transiently read an un-hydrated facade (peekProperty → undefined)
*  and drop a freshly-created schema from the rebuild. */
var peekRowProperty = (row, schema) => {
	const stored = row.properties[schema.name];
	return stored === void 0 ? void 0 : schema.codec.decode(stored);
};
/** Validates a schema block against the current presets and returns the
*  schema if it parses, or null with a logged diagnostic if not. Three
*  skip paths: (1) preset not loaded, (2) name empty, (3)
*  configCodec.decode throws. The block stays in the database
*  untouched; a fix re-runs this on the next subscription tick (or the
*  `onValuePresetsChange` re-resolve when a missing preset's plugin
*  loads). */
var tryBuildSchema = (row, presets) => {
	const presetId = peekRowProperty(row, presetIdProp) ?? "";
	if (!presetId) {
		console.warn(`[UserSchemasService] schema block ${row.id} has no presetId`);
		return null;
	}
	const preset = presets.get(presetId);
	if (!preset) {
		console.warn(`[UserSchemasService] schema block ${row.id} references unknown preset ${JSON.stringify(presetId)}; preset's plugin may not be loaded`);
		return null;
	}
	const name = peekRowProperty(row, propertyNameProp) ?? "";
	if (!name) {
		console.warn(`[UserSchemasService] schema block ${row.id} has empty propertyName`);
		return null;
	}
	let config;
	if (preset.configCodec) try {
		const raw = peekRowProperty(row, presetConfigProp) ?? {};
		config = preset.configCodec.decode(raw);
	} catch (err) {
		console.warn(`[UserSchemasService] schema "${name}" has invalid config: ${err.message}; skipping until fixed`);
		return null;
	}
	else config = void 0;
	return {
		name,
		codec: preset.build(config),
		defaultValue: preset.defaultValue,
		changeScope: ChangeScope.BlockDefault
	};
};
/** Descriptor wiring the schema bridge into the shared projector
*  lifecycle. Raw `BlockData` rows (no hydrate — see `peekRowProperty`);
*  re-resolves on `onValuePresetsChange` so a schema skipped for an
*  unknown preset resolves when that preset's plugin loads. */
var userSchemasProjector = {
	id: USER_SCHEMAS_PROJECTOR_ID,
	metaType: PROPERTY_SCHEMA_TYPE,
	targetFacet: propertySchemasFacet,
	sourceId: USER_DATA_SOURCE_ID,
	keyOf: (schema) => schema.name,
	project: (row, ctx) => tryBuildSchema(row, ctx.repo.valuePresets),
	secondarySignal: (repo, rebuild) => repo.onValuePresetsChange(rebuild)
};
/** Thin facade over the `'user-schemas'` projector. Holds no state of
*  its own — the lifecycle + the contribution list / id maps live in
*  the projector's `ProjectorHandle`, reached through `repo.projectors`.
*  Singleton on `Repo` so imperative call sites (AddPropertyForm, the
*  Roam importer) all hit the same in-memory bucket. */
var UserSchemasService = class {
	constructor(repo) {
		this.repo = repo;
	}
	get handle() {
		return this.repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID);
	}
	/** Start the schema projector for the active workspace. Returns a
	*  disposer; throws on double-start / no active workspace. */
	start() {
		return this.repo.projectors.startById(USER_SCHEMAS_PROJECTOR_ID);
	}
	dispose() {
		this.repo.projectors.disposeProjector(USER_SCHEMAS_PROJECTOR_ID);
	}
	/** Look up the property-schema block id for a registered user-data
	*  schema name. Returns undefined for kernel/plugin schemas (which
	*  don't have backing blocks) or names that aren't registered. */
	getSchemaBlockId(name) {
		return this.handle?.blockIdForKey(name);
	}
	/** Look up the published user-data schema for a property-schema
	*  block id. Returns undefined for blocks that aren't currently
	*  materializing a schema — including blocks pending hydration,
	*  blocks failing `tryBuildSchema` validation (empty name, unknown
	*  preset, invalid config), and ids that simply don't exist. */
	getSchemaForBlockId(blockId) {
		return this.handle?.contributionForBlockId(blockId);
	}
	/** Synchronously add a user-data schema to the runtime bucket. Used
	*  by `addSchema` after persisting the schema block — registers
	*  before any dependent property write so the form's "create-then-
	*  write-initial-value" flow doesn't race the subscription tick.
	*  `blockId` is the property-schema block that produced `schema`. */
	appendUserSchema(schema, blockId) {
		this.handle?.upsert(schema, blockId);
	}
	/** Create a property-schema block in the workspace's Properties
	*  page AND register the schema synchronously. Returns the freshly
	*  registered schema. */
	async addSchema(args) {
		const name = args.name.trim();
		if (!name) throw new Error("[addSchema] name is required");
		const preset = this.repo.valuePresets.get(args.presetId);
		if (!preset) throw new Error(`[addSchema] no preset registered for id ${JSON.stringify(args.presetId)}`);
		let parsedConfig;
		if (preset.configCodec) {
			const raw = args.config === void 0 ? preset.defaultConfig ?? {} : args.config;
			try {
				parsedConfig = preset.configCodec.decode(raw);
			} catch (err) {
				throw new Error(`[addSchema] invalid config for preset ${JSON.stringify(args.presetId)}: ${err.message}`, { cause: err });
			}
		} else parsedConfig = void 0;
		const newSchema = {
			name,
			codec: preset.build(parsedConfig),
			defaultValue: preset.defaultValue,
			changeScope: ChangeScope.BlockDefault
		};
		const persistConfig = preset.configCodec ? preset.configCodec.encode(parsedConfig) : {};
		const workspaceId = this.repo.activeWorkspaceId;
		const propertiesPageId = this.repo.propertiesPageId;
		if (!workspaceId || !propertiesPageId) throw new Error("[addSchema] no active workspace; properties page unavailable");
		const childId = await this.repo.mutate.createChild({
			parentId: propertiesPageId,
			position: { kind: "last" }
		});
		await this.repo.tx(async (tx) => {
			await this.repo.addTypeInTx(tx, childId, PROPERTY_SCHEMA_TYPE, {});
			await tx.setProperty(childId, propertyNameProp, name);
			await tx.setProperty(childId, presetIdProp, args.presetId);
			await tx.setProperty(childId, presetConfigProp, persistConfig);
		}, {
			scope: ChangeScope.BlockDefault,
			description: `addSchema ${name}`
		});
		if (this.repo.activeWorkspaceId === workspaceId) this.appendUserSchema(newSchema, childId);
		return newSchema;
	}
};
//#endregion
export { USER_SCHEMAS_PROJECTOR_ID, UserSchemasService, userSchemasProjector };

//# sourceMappingURL=userSchemasService.js.map