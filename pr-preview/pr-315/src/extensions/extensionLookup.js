import { EXTENSION_TYPE } from "../data/blockTypes.js";
import { extensionName } from "./extensionToggles.js";
//#region src/extensions/extensionLookup.ts
var findExtensionBlock = async (repo, workspaceId, handle) => {
	const idHint = handle.id?.trim();
	const labelHint = handle.label?.trim();
	if (!idHint && !labelHint) throw new Error("findExtensionBlock requires `id` or `label`");
	const candidates = (await repo.db.getAll(`SELECT b.id, b.content, b.properties_json
       FROM blocks b
       JOIN block_types bt ON bt.block_id = b.id AND bt.workspace_id = b.workspace_id
      WHERE b.workspace_id = ? AND b.deleted = 0 AND bt.type = ?`, [workspaceId, EXTENSION_TYPE])).map((row) => {
		const properties = (() => {
			try {
				return JSON.parse(row.properties_json);
			} catch {
				return {};
			}
		})();
		return {
			id: row.id,
			workspaceId,
			content: row.content ?? "",
			properties
		};
	});
	const match = idHint ? candidates.find((block) => block.id === idHint) ?? null : candidates.find((block) => extensionName(block) === labelHint) ?? null;
	if (!match) return null;
	return {
		block: match,
		label: extensionName(match) ?? null
	};
};
//#endregion
export { findExtensionBlock };

//# sourceMappingURL=extensionLookup.js.map