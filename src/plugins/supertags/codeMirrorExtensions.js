import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { getBlockTypes } from "../../data/properties.js";
import { EditorState } from "../../../node_modules/@codemirror/state/dist/index.js";
import { showError } from "../../utils/toast.js";
import { createTypeBlock } from "../../data/typeExtraction.js";
import { buildTypeTagCandidates, findCompletableTypeByName, planTriggerRestore, planTriggerStrip, typeTagCompletionSource } from "./typeAutocomplete.js";
//#region src/plugins/supertags/codeMirrorExtensions.ts
/** CodeMirror surface for the supertags plugin: the `#` completion
*  source contributed via `EditorState.languageData`, picked up by the
*  single central `autocompletion()` call in
*  `src/editor/autocomplete.ts` (which also themes the dropdown).
*
*  Candidates come from the live merged type registry (`repo.types` —
*  kernel + plugin + user-defined, minus `hideFromCompletion`
*  plumbing).
*
*  Pick semantics: the source deletes the `#query` trigger text from
*  the view optimistically; `pickType` here commits the tag AND the
*  matching content deletion in ONE tx. The single tx is load-bearing:
*  a types change remounts the per-block editor (types participate in
*  `DefaultBlockRenderer`'s slot identity), and the fresh editor seeds
*  from the cache — if the cached content still held the trigger text
*  (the editor's own persistence is a 300ms-debounced `setContent`),
*  the deleted text would resurrect under the user's cursor and could
*  permanently fork from what they type next.
*
*  Picking the `Create type "…"` sentinel re-checks the registry for a
*  same-named type first (an earlier create may not have published
*  when the sentinel was built — without the re-check, tagging two
*  blocks `#Recipe` in quick succession mints two "Recipe" types),
*  then materializes a definition block via `createTypeBlock` (which
*  resolves only once the new id is live in the registry).
*
*  Failures surface as a toast + trigger-text restore (handled by the
*  source; `restoreTrigger` covers the unmounted-view case). */
/** Exported for the integration test — production wiring goes through
*  `supertagsCodeMirrorExtensions` below. */
var buildTypeTagSource = ({ repo, block }) => {
	const getCandidates = (query) => {
		const data = block.peek();
		return buildTypeTagCandidates({
			registry: repo.types,
			currentTypeIds: data ? getBlockTypes(data) : [],
			query
		});
	};
	/** Tag + trigger-text removal in one tx (see module doc for why the
	*  atomicity matters). The content edit mirrors what the view
	*  already did, gated on strict snapshot equality
	*  (`planTriggerStrip`): when the stored content has moved on —
	*  unflushed keystrokes, a debounce flush that already carries the
	*  deletion — we write nothing and let the editor's own persistence
	*  own the content. */
	const applyTag = async (typeId, ctx) => {
		await repo.tx(async (tx) => {
			const data = await tx.get(block.id);
			if (!data || data.deleted) return;
			await repo.addTypeInTx(tx, block.id, typeId);
			const stripped = planTriggerStrip(data.content, ctx);
			if (stripped !== null) await tx.update(block.id, { content: stripped });
		}, {
			scope: ChangeScope.BlockDefault,
			description: `tag type ${typeId}`
		});
	};
	const pickType = async (candidate, ctx) => {
		try {
			if (candidate.kind === "existing") {
				await applyTag(candidate.id, ctx);
				return;
			}
			let typeId = findCompletableTypeByName(repo.types, candidate.label)?.id;
			if (!typeId) {
				const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId;
				if (!workspaceId) throw new Error("no workspace to create the type in");
				typeId = await createTypeBlock(repo, {
					workspaceId,
					label: candidate.label,
					propertySchemaIds: []
				});
			}
			await applyTag(typeId, ctx);
		} catch (err) {
			showError(candidate.kind === "create" ? `Couldn't finish creating type "${candidate.label}"` : `Couldn't tag with "${candidate.label}"`);
			throw err;
		}
	};
	const restoreTrigger = async (ctx) => {
		await repo.tx(async (tx) => {
			const data = await tx.get(block.id);
			if (!data || data.deleted) return;
			const restored = planTriggerRestore(data.content, ctx);
			if (restored !== null) await tx.update(block.id, { content: restored });
		}, {
			scope: ChangeScope.BlockDefault,
			description: "restore type-tag trigger text"
		});
	};
	return typeTagCompletionSource({
		getCandidates,
		pickType,
		restoreTrigger
	});
};
var supertagsCodeMirrorExtensions = (ctx) => {
	const source = buildTypeTagSource(ctx);
	return [EditorState.languageData.of(() => [{ autocomplete: source }])];
};
//#endregion
export { buildTypeTagSource, supertagsCodeMirrorExtensions };

//# sourceMappingURL=codeMirrorExtensions.js.map