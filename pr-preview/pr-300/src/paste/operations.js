import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { isCollapsedProp } from "../data/properties.js";
import { keysBetween } from "../data/orderKey.js";
import { keysImmediatelyAfter, keysImmediatelyBefore } from "../data/orderKeyPlacement.js";
import { revealChildren } from "../data/mutators.js";
import { parseMarkdownToBlocks, singleParsedBlock } from "../utils/markdownParser.js";
import { captureMediaVerb } from "./captureMediaVerb.js";
import { pasteDecisionVerb } from "./decision.js";
//#region src/paste/operations.ts
/** Classify a keydown as a paste chord. The paste `ClipboardEvent` that
*  follows carries no modifier state, so callers capture the intent here
*  (on keydown) and route the subsequent paste accordingly:
*   - `split` (Cmd/Ctrl+V) — multi-line text splits into a block tree.
*   - `single-block` (Cmd/Ctrl+Shift+V) — text drops into the current
*     block verbatim (Roam's "paste as plain text").
*  Returns null for non-paste keys. Browsers report the key as 'v' or
*  'V' depending on Shift, and AltGr/Option pastes are excluded. */
var pasteChordIntent = (event) => {
	if (!((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "v" || event.key === "V"))) return null;
	return event.shiftKey ? "single-block" : "split";
};
/** Plan a verbatim paste into the current block: replace the selected
*  range with the pasted text, keeping its newlines. CRLF/CR are
*  normalized to LF to match CodeMirror's own line-ending normalization,
*  so the resulting cursor offset can't land past the document end. */
var planSingleBlockPaste = (pastedText, selection) => {
	const insert = pastedText.replace(/\r\n?/g, "\n");
	return {
		insert,
		from: selection.from,
		to: selection.to,
		cursor: selection.from + insert.length
	};
};
var isBlankContent = (content) => content.trim().length === 0;
var isCollapsed = (properties) => {
	const raw = properties[isCollapsedProp.name];
	return raw === void 0 ? isCollapsedProp.defaultValue : isCollapsedProp.codec.decode(raw);
};
var editorContentForFirstPastedLine = (pastedText, fallback) => {
	const line = pastedText.split("\n").find((item) => item.trim().length > 0);
	if (line === void 0) return fallback;
	const bullet = line.trim().match(/^[-*+]\s+(.*)$/);
	if (bullet) return bullet[1];
	return line.replace(/\r$/, "");
};
var insertionForFirstChild = (firstExistingOrderKey) => ({ keys: async (n) => keysBetween(null, firstExistingOrderKey ?? null, n) });
var insertionForSiblingRun = (tx, parentId, siblings, targetId, position) => {
	const ix = siblings.findIndex((s) => s.id === targetId);
	if (ix < 0) throw new Error(`paste target ${targetId} not found among siblings`);
	return { keys: (n) => position === "after" ? keysImmediatelyAfter(tx, parentId, siblings, ix, n) : keysImmediatelyBefore(tx, parentId, siblings, ix, n) };
};
var resolveRootDestination = async (tx, target, { position, scopeRootId, placement }) => {
	const targetChildren = await tx.childrenOf(target.id, target.workspaceId);
	const targetIsScopeRoot = scopeRootId === target.id;
	const targetHasVisibleChildren = targetChildren.length > 0 && !isCollapsed(target.properties);
	const rootsAsChildren = targetIsScopeRoot || target.parentId === null || placement === "visible" && position === "after" && targetHasVisibleChildren;
	const rootParentId = rootsAsChildren ? target.id : target.parentId;
	if (!rootParentId) throw new Error(`paste target ${target.id} has no visible insertion parent`);
	if (rootsAsChildren) await revealChildren(tx, target.id);
	return {
		rootParentId,
		rootInsertion: rootsAsChildren ? insertionForFirstChild(targetChildren[0]?.orderKey) : insertionForSiblingRun(tx, rootParentId, await tx.childrenOf(rootParentId, target.workspaceId), target.id, position),
		targetChildren
	};
};
/** Shared placement math for both multiline-paste paths: which blocks to
*  create, where each lands, and the order keys for blocks inserted among an
*  existing parent's children. The ordering invariants live in the
*  keysBetween / insertionForFirstChild primitives this delegates to — this
*  only groups blocks by destination parent and assigns the returned keys. */
var planPastePlacement = async (tx, target, parsedBlocks, absorbedRootId, { rootParentId, rootInsertion, targetChildren }) => {
	const blocksToCreate = parsedBlocks.filter((block) => block.id !== absorbedRootId);
	const createdParsedIds = new Set(blocksToCreate.map((block) => block.id));
	const finalParentId = (block) => {
		if (!block.parentId) return rootParentId;
		if (block.parentId === absorbedRootId) return target.id;
		return block.parentId;
	};
	const existingParentGroups = /* @__PURE__ */ new Map();
	for (const block of blocksToCreate) {
		const parentId = finalParentId(block);
		if (createdParsedIds.has(parentId)) continue;
		const group = existingParentGroups.get(parentId) ?? [];
		group.push(block);
		existingParentGroups.set(parentId, group);
	}
	const orderKeysByParsedId = /* @__PURE__ */ new Map();
	for (const [parentId, blocks] of existingParentGroups) {
		const keys = await (parentId === rootParentId ? rootInsertion : insertionForFirstChild(parentId === target.id ? targetChildren[0]?.orderKey : (await tx.childrenOf(parentId, target.workspaceId))[0]?.orderKey)).keys(blocks.length);
		blocks.forEach((block, index) => orderKeysByParsedId.set(block.id, keys[index]));
	}
	return {
		blocksToCreate,
		finalParentId,
		orderKeysByParsedId
	};
};
var planEditModeMultilinePaste = (pastedText, currentContent, selection) => {
	const parsed = parseMarkdownToBlocks(pastedText);
	const absorbedRoot = parsed.find((block) => !block.parentId);
	if (!absorbedRoot) return null;
	const from = Math.max(0, Math.min(selection.from, currentContent.length));
	const to = Math.max(from, Math.min(selection.to ?? selection.from, currentContent.length));
	const prefix = currentContent.slice(0, from);
	const suffix = currentContent.slice(to);
	const createsAdditionalBlocks = parsed.some((block) => block.id !== absorbedRoot.id);
	const contentBeforeStructuralBreak = `${prefix}${editorContentForFirstPastedLine(pastedText, absorbedRoot.content)}`;
	return {
		parsed,
		absorbedRoot,
		targetContent: createsAdditionalBlocks ? contentBeforeStructuralBreak : `${contentBeforeStructuralBreak}${suffix}`,
		focusOffsetInTarget: contentBeforeStructuralBreak.length,
		suffix: createsAdditionalBlocks ? suffix : ""
	};
};
/** Paste markdown text into the outline around a target block.
*
*  Rewrites parsed blocks into one `repo.tx`:
*   - Empty targets absorb the first pasted root.
*   - Root-level parsed blocks become visible siblings or first
*     children depending on paste placement, expansion, and zoom.
*   - Non-root parsed blocks keep their `parentId` (intra-paste tree
*     structure), except children of an absorbed root become children
*     of the target.
*
*  Returns the Block facades of the root-level pasted blocks in the
*  resulting visible paste scope. */
async function pasteMultilineText(pastedText, pasteTarget, repo, { position = "after", scopeRootId, placement = "visible", asSingleBlock = false } = {}) {
	if (!(pasteTarget.peek() ?? await pasteTarget.load())) return [];
	if (asSingleBlock && isBlankContent(pastedText)) return [];
	const parsed = asSingleBlock ? [singleParsedBlock(pastedText)] : parseMarkdownToBlocks(pastedText);
	if (parsed.length === 0) return [];
	const parsedRoots = parsed.filter((block) => !block.parentId);
	const rootBlocks = [];
	await repo.tx(async (tx) => {
		const target = await tx.get(pasteTarget.id);
		if (!target) return;
		const destination = await resolveRootDestination(tx, target, {
			position,
			scopeRootId,
			placement
		});
		const absorbedRoot = isBlankContent(target.content) ? parsedRoots[0] : void 0;
		if (absorbedRoot) {
			await tx.update(target.id, { content: absorbedRoot.content });
			rootBlocks.push(repo.block(target.id));
		}
		const { blocksToCreate, finalParentId, orderKeysByParsedId } = await planPastePlacement(tx, target, parsed, absorbedRoot?.id, destination);
		for (const block of blocksToCreate) {
			const parentId = finalParentId(block);
			const id = await tx.create({
				id: block.id,
				workspaceId: target.workspaceId,
				parentId,
				orderKey: orderKeysByParsedId.get(block.id) ?? block.orderKey,
				content: block.content
			});
			if (!block.parentId) rootBlocks.push(repo.block(id));
		}
	}, {
		scope: ChangeScope.BlockDefault,
		description: "paste multiline text"
	});
	return rootBlocks;
}
async function pasteEditModeMultilineText(plan, pasteTarget, repo, options = {}) {
	const rootBlocks = [];
	let focusBlock = pasteTarget;
	let focusOffset = plan.focusOffsetInTarget;
	await repo.tx(async (tx) => {
		const target = await tx.get(pasteTarget.id);
		if (!target) return;
		const destination = await resolveRootDestination(tx, target, {
			position: "after",
			scopeRootId: options.scopeRootId,
			placement: "sibling"
		});
		await tx.update(target.id, { content: plan.targetContent });
		rootBlocks.push(repo.block(target.id));
		const { blocksToCreate, finalParentId, orderKeysByParsedId } = await planPastePlacement(tx, target, plan.parsed, plan.absorbedRoot.id, destination);
		const lastCreatedBlock = blocksToCreate.at(-1);
		for (const block of blocksToCreate) {
			const parentId = finalParentId(block);
			const isFocusBlock = block.id === lastCreatedBlock?.id;
			const id = await tx.create({
				id: block.id,
				workspaceId: target.workspaceId,
				parentId,
				orderKey: orderKeysByParsedId.get(block.id) ?? block.orderKey,
				content: isFocusBlock ? `${block.content}${plan.suffix}` : block.content
			});
			if (!block.parentId) rootBlocks.push(repo.block(id));
			if (isFocusBlock) {
				focusBlock = repo.block(id);
				focusOffset = block.content.length;
			}
		}
	}, {
		scope: ChangeScope.BlockDefault,
		description: "paste multiline text at editor selection"
	});
	return {
		pasted: rootBlocks,
		focusBlock,
		focusOffset
	};
}
/** Resolve a paste decision, performing MEDIA CAPTURE when the decision is `media`:
*  capture the files via {@link captureMediaVerb} (the attachments plugin's effect —
*  this module never imports the plugin), splice the returned `((id))` reference text
*  into the paste, and RE-DECIDE with the files stripped so the references flow through
*  the normal text path (landing at the caret like any pasted text, not a forced
*  child). Surface-agnostic: the caller applies the returned decision its own way
*  (outline insert vs editor dispatch), and reads `request.surface`/`caret` itself.
*
*  Returns `null` when there's nothing to paste — a capture that yielded no references
*  AND no accompanying text, or a plugin that returned `media` with no files. A
*  capture THROW is swallowed (a buggy plugin must not break the paste; the text
*  half still pastes). The capture awaits, so a caller with a DETACHABLE surface (an
*  editor view that can unmount mid-await) must re-check liveness AFTER this resolves
*  and before applying. */
async function resolvePasteWithMediaCapture(runtime, request, capture) {
	const decided = pasteDecisionVerb.runSync(runtime, request);
	if (decided.kind !== "media") return {
		decision: decided,
		text: decided.text ?? request.text
	};
	const files = request.files ?? [];
	let references = [];
	if (capture.workspaceId && files.length > 0) try {
		references = (await captureMediaVerb.run(runtime, {
			repo: capture.repo,
			workspaceId: capture.workspaceId,
			files
		})).references;
	} catch (err) {
		console.warn("[media] paste capture failed", err);
	}
	else if (files.length > 0) console.warn("[media] could not capture pasted file(s): no workspace");
	const text = [request.text, ...references].filter(Boolean).join("\n");
	if (!text) return null;
	const decision = pasteDecisionVerb.runSync(runtime, {
		...request,
		text,
		files: []
	});
	if (decision.kind === "media") return null;
	return {
		decision,
		text: decision.text ?? text
	};
}
/** Read the clipboard and paste it around `pasteTarget`. This is the
*  funnel for shortcut / programmatic paste (vim normal-mode, multi-select
*  actions) — there's no `ClipboardEvent` and no text caret.
*
*  Routed through `pasteDecisionVerb` (surface `shell`) so plugin overrides
*  — text rewrites, a forced single-block, observers — apply to shortcut
*  paste exactly as they do to the DOM block-shell paste; keeping all
*  clipboard paste behind this one funnel stops a new call site from
*  silently bypassing the seam. Falls back to the raw outline paste only
*  when no runtime is installed yet (very early boot / minimal harness).
*
*  The clipboard API read is text-only, so `PasteRequest.html` is undefined
*  on this surface — a format-aware override keyed on `text/html` (e.g.
*  CSV→table from a spreadsheet copy) fires for DOM paste but not here. */
async function pasteFromClipboard(pasteTarget, repo, options = {}) {
	const text = await navigator.clipboard.readText();
	if (!text) return [];
	const runtime = repo.facetRuntime;
	if (!runtime) return pasteMultilineText(text, pasteTarget, repo, options);
	const decision = pasteDecisionVerb.runSync(runtime, {
		text,
		intent: "split",
		surface: "shell"
	});
	if (decision.kind === "media") return pasteMultilineText(text, pasteTarget, repo, options);
	return pasteMultilineText(decision.text ?? text, pasteTarget, repo, {
		...options,
		asSingleBlock: decision.kind === "single-block"
	});
}
//#endregion
export { pasteChordIntent, pasteEditModeMultilineText, pasteFromClipboard, pasteMultilineText, planEditModeMultilinePaste, planSingleBlockPaste, resolvePasteWithMediaCapture };

//# sourceMappingURL=operations.js.map