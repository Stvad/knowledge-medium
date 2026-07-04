import { ChangeScope } from "./api/changeScope.js";
import { BlockNotFoundForTypeError } from "./api/errors.js";
import "./api/index.js";
import { getBlockTypes, typesProp } from "./properties.js";
//#region src/data/typeTagger.ts
var TypeTagger = class {
	constructor(host) {
		this.host = host;
	}
	async _addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, strict) {
		if (types.get(typeId) === void 0) throw new Error(`[addType] type id ${JSON.stringify(typeId)} is not registered. Register a TypeContribution through typesFacet before calling addType.`);
		const block = await tx.get(blockId);
		if (!block) {
			if (strict) throw new BlockNotFoundForTypeError(blockId, typeId, "missing");
			return;
		}
		if (block.deleted) {
			if (strict) throw new BlockNotFoundForTypeError(blockId, typeId, "tombstoned");
			return;
		}
		const current = getBlockTypes(block);
		const wasNew = !current.includes(typeId);
		const next = { ...block.properties };
		let propsChanged = false;
		if (wasNew) {
			next[typesProp.name] = typesProp.codec.encode([...current, typeId]);
			propsChanged = true;
		}
		for (const [name, value] of Object.entries(initialValues)) {
			if (next[name] !== void 0) continue;
			const schema = propertySchemas.get(name);
			if (schema === void 0) throw new Error(`[addType] initialValues[${JSON.stringify(name)}] has no registered PropertySchema in the merged registry.`);
			next[name] = schema.codec.encode(value);
			propsChanged = true;
		}
		if (propsChanged) await tx.update(blockId, { properties: next });
	}
	async _removeTypeInTx(tx, blockId, typeId) {
		const block = await tx.get(blockId);
		if (!block) return;
		const current = getBlockTypes(block);
		if (!current.includes(typeId)) return;
		const next = {
			...block.properties,
			[typesProp.name]: typesProp.codec.encode(current.filter((t) => t !== typeId))
		};
		await tx.update(blockId, { properties: next });
	}
	/** Strict: throws `BlockNotFoundForTypeError` if `blockId` is missing
	*  or tombstoned at write time. Use when the caller's correctness
	*  depends on the tag actually landing (orchestration / fan-out
	*  paths). For the lenient variant that silently no-ops on a missing
	*  block, see `addTypeInTxLenient` and (in-tx) the dedicated lenient
	*  entry points. */
	async addType(blockId, typeId, initialValues = {}) {
		const { types, propertySchemas } = this.host.snapshotTypeRegistries();
		await this.host.tx(async (tx) => {
			await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, true);
		}, {
			scope: ChangeScope.BlockDefault,
			description: `addType ${typeId}`
		});
	}
	/** Strict in-tx variant. Throws `BlockNotFoundForTypeError` if the
	*  target block is missing or tombstoned. The default for orchestration
	*  code; pair with the lenient variant only when racing a concurrent
	*  delete is legitimate (sync-apply / processor paths). */
	async addTypeInTx(tx, blockId, typeId, initialValues = {}, snapshot) {
		const types = snapshot?.types ?? this.host.types;
		const propertySchemas = snapshot?.propertySchemas ?? this.host.propertySchemas;
		await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, true);
	}
	/** Lenient in-tx variant — silently no-ops if the target block is
	*  missing or tombstoned. Reserved for sync-apply / processor paths
	*  that may legitimately observe a concurrent delete between
	*  pre-tx state and tx-start. New orchestration code should prefer
	*  `addTypeInTx` (strict) so a footgun like the Roam-isa adoption
	*  bug (PR #47) can't be expressed. */
	async addTypeInTxLenient(tx, blockId, typeId, initialValues = {}, snapshot) {
		const types = snapshot?.types ?? this.host.types;
		const propertySchemas = snapshot?.propertySchemas ?? this.host.propertySchemas;
		await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, false);
	}
	async removeType(blockId, typeId) {
		await this.host.tx(async (tx) => {
			await this._removeTypeInTx(tx, blockId, typeId);
		}, {
			scope: ChangeScope.BlockDefault,
			description: `removeType ${typeId}`
		});
	}
	async removeTypeInTx(tx, blockId, typeId) {
		await this._removeTypeInTx(tx, blockId, typeId);
	}
	async toggleType(blockId, typeId) {
		const { types, propertySchemas } = this.host.snapshotTypeRegistries();
		await this.host.tx(async (tx) => {
			const block = await tx.get(blockId);
			if (!block || block.deleted) return;
			if (getBlockTypes(block).includes(typeId)) await this._removeTypeInTx(tx, blockId, typeId);
			else await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {}, false);
		}, {
			scope: ChangeScope.BlockDefault,
			description: `toggleType ${typeId}`
		});
	}
	async setBlockTypes(blockId, typeIds) {
		const desiredOrder = Array.from(new Set(typeIds));
		const { types, propertySchemas } = this.host.snapshotTypeRegistries();
		await this.host.tx(async (tx) => {
			const block = await tx.get(blockId);
			if (!block || block.deleted) return;
			const current = getBlockTypes(block);
			const want = new Set(desiredOrder);
			for (const typeId of current) if (!want.has(typeId)) await this._removeTypeInTx(tx, blockId, typeId);
			const currentSet = new Set(current);
			for (const typeId of desiredOrder) {
				if (currentSet.has(typeId)) continue;
				await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {}, false);
			}
			const after = await tx.get(blockId);
			if (!after) return;
			const stored = getBlockTypes(after);
			if (stored.length === desiredOrder.length && stored.every((typeId, index) => typeId === desiredOrder[index])) return;
			await tx.update(blockId, { properties: {
				...after.properties,
				[typesProp.name]: typesProp.codec.encode(desiredOrder)
			} });
		}, {
			scope: ChangeScope.BlockDefault,
			description: "setBlockTypes"
		});
	}
};
//#endregion
export { TypeTagger };

//# sourceMappingURL=typeTagger.js.map