import { ChangeScope } from "./api/changeScope.js";
import "./api/index.js";
import { aliasesProp, hasBlockType } from "./properties.js";
import v5 from "../../node_modules/uuid/dist/v5.js";
import { PAGE_TYPE } from "./blockTypes.js";
//#region src/data/kernelPage.ts
/** Per-workspace kernel-page bootstrap. Each workspace owns a small set
*  of singleton pages (Properties, Types, future Saved Queries /
*  Dashboards / Command palette). They share a shape: deterministic
*  uuid-v5 id derived from `workspaceId`, alias-based human-readable
*  surface, navigable as a normal page (`PAGE_TYPE`) plus a marker
*  block-type so `block_types`-indexed lookups can find them, and
*  soft-delete-restore on first reach.
*
*  Idempotent across offline launches — two clients booting offline
*  converge on the same row at next sync.
*/
var stringListProperty = (raw) => Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
var includesAll = (existing, expected) => expected.every((value) => existing.includes(value));
var mergeStrings = (values) => Array.from(new Set(values));
/** Deterministic block id for a kernel page in a given workspace. */
var kernelPageBlockId = (workspaceId, namespace) => v5(workspaceId, namespace);
/** Get-or-create a per-workspace kernel page. Repairs a live page that's
*  missing the expected types or alias; restores a soft-deleted row;
*  otherwise creates fresh. */
var getOrCreateKernelPage = async (repo, workspaceId, spec) => {
	const id = kernelPageBlockId(workspaceId, spec.namespace);
	const aliases = [spec.alias];
	const orderKey = spec.orderKey ?? "a0";
	const live = await repo.load(id);
	if (live) {
		const currentAliases = stringListProperty(live.properties[aliasesProp.name]);
		if (!(!hasBlockType(live, "page") || !hasBlockType(live, spec.markerType) || !includesAll(currentAliases, aliases))) return repo.block(id);
		const typeSnapshot = repo.snapshotTypeRegistries();
		await repo.tx(async (tx) => {
			const current = await tx.get(id);
			if (!current || current.deleted) return;
			const txAliases = stringListProperty(current.properties[aliasesProp.name]);
			if (!includesAll(txAliases, aliases)) await tx.setProperty(id, aliasesProp, mergeStrings([...aliases, ...txAliases]));
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: aliases }, typeSnapshot);
			await repo.addTypeInTx(tx, id, spec.markerType, { [aliasesProp.name]: aliases }, typeSnapshot);
		}, { scope: ChangeScope.BlockDefault });
		return repo.block(id);
	}
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const existing = await tx.get(id);
		if (existing && !existing.deleted) return;
		if (existing && existing.deleted) {
			await tx.restore(id, { content: spec.alias });
			await tx.setProperty(id, aliasesProp, [...aliases]);
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: aliases }, typeSnapshot);
			await repo.addTypeInTx(tx, id, spec.markerType, { [aliasesProp.name]: aliases }, typeSnapshot);
			return;
		}
		await tx.create({
			id,
			workspaceId,
			parentId: null,
			orderKey,
			content: spec.alias
		}, { systemMint: true });
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: aliases }, typeSnapshot);
		await repo.addTypeInTx(tx, id, spec.markerType, { [aliasesProp.name]: aliases }, typeSnapshot);
	}, { scope: ChangeScope.BlockDefault });
	return repo.block(id);
};
//#endregion
export { getOrCreateKernelPage, kernelPageBlockId };

//# sourceMappingURL=kernelPage.js.map