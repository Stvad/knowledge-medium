import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
import { showError } from "../utils/toast.js";
import { resolveEditModeKeepalive, withEditModeKeepalive } from "../components/editModeKeepalive.js";
import { captureMediaVerb } from "../paste/captureMediaVerb.js";
//#region src/editor/insertImage.ts
/**
* Pick image file(s) from the OS and insert their captured `((assetBlockId))`
* reference(s) at the editor's caret — the editor-layer counterpart to the
* paste path, reusable from any edit-mode surface (the mobile keyboard toolbar
* button, the command palette, a future desktop button).
*
* It deliberately owns the whole awkward async-picker dance so callers don't
* have to: snapshot the caret up front (the picker blurs the editor), hold edit
* mode alive across the round-trip, capture through the shared media seam, and
* refocus when done. Capture goes through {@link captureMediaVerb} (the
* attachments plugin's effect) so byte storage / upload / content-dedup live in
* exactly one place and this never imports the plugin.
*/
var INSERT_IMAGE_ACTION_ID = "edit.cm.insert_image";
/** Normal-mode variant (no caret) — appends the image to the focused block. */
var INSERT_IMAGE_NORMAL_MODE_ACTION_ID = "insert_image";
/** Open the OS file picker for image(s); resolves with the chosen files, or an
*  empty array if the user dismissed it. MUST be called synchronously inside a
*  user gesture (it clicks a transient `<input>` before returning) or the
*  browser won't open the picker. */
function pickImageFiles() {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.style.position = "fixed";
		input.style.left = "-9999px";
		let settled = false;
		let backstop = 0;
		const cleanup = (files) => {
			if (settled) return;
			settled = true;
			input.removeEventListener("change", onChange);
			input.removeEventListener("cancel", onCancel);
			window.removeEventListener("focus", onWindowFocus);
			window.clearTimeout(backstop);
			input.remove();
			resolve(files);
		};
		const onChange = () => cleanup(input.files ? Array.from(input.files) : []);
		const onCancel = () => cleanup([]);
		const onWindowFocus = () => {
			window.setTimeout(() => {
				if (!input.files || input.files.length === 0) cleanup([]);
			}, 300);
		};
		backstop = window.setTimeout(() => cleanup([]), 3 * 6e4);
		input.addEventListener("change", onChange);
		input.addEventListener("cancel", onCancel);
		window.addEventListener("focus", onWindowFocus);
		document.body.appendChild(input);
		input.click();
	});
}
/** Append reference text to a block's content on its own line(s), guarding a
*  not-resident or deleted block: `peek()` is `undefined` (not loaded) or `null`
*  (deleted/missing), and a bare `?? ''` would overwrite real content — or write
*  into a tombstone. (The soft-delete model means such a write can't actually
*  "resurrect" a deleted block — `load()` filters `deleted = 0` — but bailing
*  still avoids a pointless tombstone write and reads the right content on the
*  live-row path.) References are one-per-line, matching the paste path's
*  separator (src/paste/operations.ts) so a multi-image insert reads the same
*  however it arrived. Shared by the normal-mode append and the edit-mode
*  editor-unmounted fallback. */
async function appendReferencesToBlock(block, references) {
	const data = block.peek() ?? await block.load();
	if (!data) return;
	const refsText = references.join("\n");
	const base = (data.content ?? "").replace(/\s+$/, "");
	await block.setContent(base ? `${base}\n${refsText}` : refsText);
}
/** Insert the captured references for an edit-mode pick. With a live editor,
*  insert at the editor's CURRENT selection — read NOW, not from a stale
*  pre-picker snapshot: the doc can change while the picker is open (a remote
*  edit, or the editor's own late commit), and CodeMirror has already remapped
*  its selection through that change. Inserting at a stale offset could land
*  mid-word or *inside* an existing `((ref))` and corrupt it. If the editor
*  unmounted while the picker was open there's no trustworthy caret left, so
*  append to the block rather than splice at a stale position. Exported for
*  tests. */
async function insertReferences(editorView, block, references) {
	if (editorView.dom.isConnected) {
		const insertText = references.join("\n");
		const { from, to } = editorView.state.selection.main;
		editorView.dispatch({
			changes: {
				from,
				to,
				insert: insertText
			},
			selection: EditorSelection.cursor(from + insertText.length)
		});
		editorView.focus();
		return;
	}
	await appendReferencesToBlock(block, references);
}
/** Capture already-read files into `((assetBlockId))` reference strings via the
*  shared media seam, deriving repo/runtime/workspace from the target block.
*  Returns [] when there's nothing to insert (no runtime/workspace) or when
*  capture failed. Per-file failures the impl anticipates (oversize, locked
*  workspace) come back as a resolved outcome and are toasted there — but
*  `captureMediaVerb` is `onError: 'rethrow'`, so an UNEXPECTED throw (e.g. a
*  file the OS revoked between pick and read) would otherwise surface nowhere:
*  both callers only `console.error` a rejection. Catch it here and toast, so a
*  failed capture never silently swallows the user's pick. */
async function captureFilesToReferences(block, files) {
	const repo = block.repo;
	const runtime = repo.facetRuntime;
	if (!runtime) return [];
	const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? "";
	if (!workspaceId) {
		showError("Open a workspace to attach images.");
		return [];
	}
	try {
		const { references } = await captureMediaVerb.run(runtime, {
			repo,
			workspaceId,
			files: [...files]
		});
		return [...references];
	} catch (error) {
		console.warn("[insertImage] media capture failed", error);
		showError("Could not attach the image.");
		return [];
	}
}
/** Pick image file(s) and insert their captured references at the editor's
*  caret. MUST be reached synchronously from a user gesture (it clicks the
*  picker before its first await) so the OS picker actually opens. */
async function pickAndInsertImages({ editorView, block }) {
	try {
		await withEditModeKeepalive("refocus", async () => {
			const files = await pickImageFiles();
			if (files.length === 0) return;
			const references = await captureFilesToReferences(block, files);
			if (references.length === 0) return;
			await insertReferences(editorView, block, references);
		});
	} finally {
		requestAnimationFrame(() => {
			if (resolveEditModeKeepalive() !== "yield" && editorView.dom.isConnected) editorView.focus();
		});
	}
}
/** Pick image file(s) and append their captured references to a block's
*  content — the normal-mode counterpart to {@link pickAndInsertImages}, for
*  when there's no editor/caret (a focused-but-not-editing block). No keepalive:
*  there's no edit-mode session to preserve. Appends on its own line(s) — the
*  image renders inline after the block's existing content, matching the
*  at-caret insert's "inline in this block" semantics. MUST be reached
*  synchronously from a user gesture so the picker opens. */
async function pickImagesIntoBlock(block) {
	const files = await pickImageFiles();
	if (files.length === 0) return;
	const references = await captureFilesToReferences(block, files);
	if (references.length === 0) return;
	await appendReferencesToBlock(block, references);
}
//#endregion
export { INSERT_IMAGE_ACTION_ID, INSERT_IMAGE_NORMAL_MODE_ACTION_ID, pickAndInsertImages, pickImagesIntoBlock };

//# sourceMappingURL=insertImage.js.map