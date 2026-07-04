import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp, typesProp } from "../../data/properties.js";
import v4 from "../../../node_modules/uuid/dist/v4.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { keyAtEnd } from "../../data/orderKey.js";
import { placeAddressProp, placeCategoriesProp, placeGoogleMapsUrlProp, placeGooglePlaceIdProp, placeLatProp, placeLngProp, placePhoneProp, placeWebsiteProp } from "./properties.js";
import { PLACE_TYPE } from "./blockTypes.js";
import { getOrCreateLocationsPage } from "./locationsPage.js";
//#region src/plugins/geo/createOrFindPlace.ts
/** `createOrFindPlace` — alias-based dedup + Place block creation.
*  Single entry point used by the `@` autocomplete (Phase C), the
*  property editor (Phase E), and the current-location flow (Phase F).
*
*  Dedup rules:
*    - Google POI: aliases = [name, `place:<googlePlaceId>`]. The
*      machine-form alias is what we look up by — names drift, ids
*      don't.
*    - Ad-hoc coordinate pin: aliases = [`geo:<lat>,<lng>`] with lat/lng
*      rounded to 5 decimals (~1m precision). Two pins dropped at the
*      same spot dedup; exact-float dedup is brittle and an unwanted
*      strictness.
*
*  Friendly-name collisions are preflighted, not attempted: when the
*  candidate's name is already an alias on a different block, the
*  doomed create (the alias-uniqueness trigger would roll the whole tx
*  back) is skipped and a `name-collision` result returned instead, so
*  callers can resolve the conflict with intent — enrich the existing
*  block via `addPlaceToExistingBlock`, or retry under another name.
*
*  Locations page is bootstrapped lazily on first call. */
var COORD_DEDUP_DECIMALS = 5;
var roundCoord = (n) => n.toFixed(COORD_DEDUP_DECIMALS);
/** Public for test access — same machine alias the lookup uses. */
var placeMachineAlias = (candidate) => candidate.googlePlaceId ? `place:${candidate.googlePlaceId}` : `geo:${roundCoord(candidate.lat)},${roundCoord(candidate.lng)}`;
var aliasesFor = (candidate, machineAlias) => {
	const name = candidate.name.trim();
	if (name.length === 0 || name === machineAlias) return [machineAlias];
	return [name, machineAlias];
};
var contentFor = (candidate, machineAlias) => {
	const name = candidate.name.trim();
	return name.length > 0 ? name : machineAlias;
};
/** Query-hydrated `BlockData` carries decoded property values. */
var isPlaceData = (block) => {
	const raw = block.properties[typesProp.name];
	return Array.isArray(raw) && raw.includes("place");
};
/** Tx-level `BlockData` carries encoded property values. */
var txAliases = (block) => {
	const encoded = block.properties[aliasesProp.name];
	if (encoded === void 0) return [];
	try {
		return [...aliasesProp.codec.decode(encoded)];
	} catch {
		return [];
	}
};
var collisionResult = (name, machineAlias, claimant) => ({
	kind: "name-collision",
	name,
	machineAlias,
	existing: {
		id: claimant.id,
		content: claimant.content,
		isPlace: isPlaceData(claimant)
	}
});
var writePlaceProps = async (tx, id, candidate) => {
	await tx.setProperty(id, placeLatProp, candidate.lat);
	await tx.setProperty(id, placeLngProp, candidate.lng);
	if (candidate.address !== void 0) await tx.setProperty(id, placeAddressProp, candidate.address);
	if (candidate.googlePlaceId !== void 0) await tx.setProperty(id, placeGooglePlaceIdProp, candidate.googlePlaceId);
	if (candidate.googleMapsUrl !== void 0) await tx.setProperty(id, placeGoogleMapsUrlProp, candidate.googleMapsUrl);
	if (candidate.website !== void 0) await tx.setProperty(id, placeWebsiteProp, candidate.website);
	if (candidate.phone !== void 0) await tx.setProperty(id, placePhoneProp, candidate.phone);
	if (candidate.categories !== void 0 && candidate.categories.length > 0) await tx.setProperty(id, placeCategoriesProp, [...candidate.categories]);
};
var createOrFindPlace = async (repo, workspaceId, candidate) => {
	const machineAlias = placeMachineAlias(candidate);
	const existing = await repo.query.aliasLookup({
		workspaceId,
		alias: machineAlias
	}).load();
	if (existing) return {
		kind: "ok",
		block: repo.block(existing.id)
	};
	const aliases = aliasesFor(candidate, machineAlias);
	const friendlyName = aliases.find((a) => a !== machineAlias);
	if (friendlyName !== void 0) {
		const claimant = await repo.query.aliasLookup({
			workspaceId,
			alias: friendlyName
		}).load();
		if (claimant) return collisionResult(friendlyName, machineAlias, claimant);
	}
	const content = contentFor(candidate, machineAlias);
	const id = v4();
	let resolvedId = id;
	let racedNameClaim = false;
	await repo.undoGroup(async (grouped) => {
		const locationsPage = await getOrCreateLocationsPage(grouped, workspaceId);
		const typeSnapshot = grouped.snapshotTypeRegistries();
		await grouped.tx(async (tx) => {
			const raced = await tx.aliasLookup(machineAlias, workspaceId);
			if (raced) {
				resolvedId = raced.id;
				return;
			}
			if (friendlyName !== void 0) {
				if (await tx.aliasLookup(friendlyName, workspaceId)) {
					racedNameClaim = true;
					return;
				}
			}
			await tx.create({
				id,
				workspaceId,
				parentId: locationsPage.id,
				orderKey: keyAtEnd(),
				content
			});
			await tx.setProperty(id, aliasesProp, [...aliases]);
			await grouped.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: [...aliases] }, typeSnapshot);
			await grouped.addTypeInTx(tx, id, PLACE_TYPE, { [aliasesProp.name]: [...aliases] }, typeSnapshot);
			await writePlaceProps(tx, id, candidate);
		}, {
			scope: ChangeScope.BlockDefault,
			description: "create place"
		});
	});
	if (racedNameClaim && friendlyName !== void 0) {
		const claimant = await repo.query.aliasLookup({
			workspaceId,
			alias: friendlyName
		}).load();
		if (claimant === null) return createOrFindPlace(repo, workspaceId, candidate);
		return collisionResult(friendlyName, machineAlias, claimant);
	}
	return {
		kind: "ok",
		block: repo.block(resolvedId)
	};
};
/** Resolve a `name-collision` by enriching the claimant in place: tag
*  it as a Place (and page), write the coords/Google props, and append
*  the machine alias so future `createOrFindPlace` calls for the same
*  POI dedup onto it. Content and existing aliases are preserved —
*  the block keeps being whatever the user made it, it just gains a
*  location. */
var addPlaceToExistingBlock = async (repo, blockId, candidate) => {
	const machineAlias = placeMachineAlias(candidate);
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const block = await tx.get(blockId);
		if (!block || block.deleted) throw new Error(`addPlaceToExistingBlock: block ${blockId} not found`);
		const aliases = txAliases(block);
		if (!aliases.includes(machineAlias)) await tx.setProperty(blockId, aliasesProp, [...aliases, machineAlias]);
		await repo.addTypeInTx(tx, blockId, PAGE_TYPE, {}, typeSnapshot);
		await repo.addTypeInTx(tx, blockId, PLACE_TYPE, {}, typeSnapshot);
		await writePlaceProps(tx, blockId, candidate);
	}, {
		scope: ChangeScope.BlockDefault,
		description: "add place to existing block"
	});
	return repo.block(blockId);
};
//#endregion
export { addPlaceToExistingBlock, createOrFindPlace, placeMachineAlias };

//# sourceMappingURL=createOrFindPlace.js.map