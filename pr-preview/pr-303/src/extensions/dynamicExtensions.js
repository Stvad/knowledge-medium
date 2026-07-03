import { isFacetContribution } from "../facets/facet.js";
import { attachBoundary, getBoundary, isEnabled } from "../facets/togglable.js";
import { compileForVerification, hashExtensionSource, loadApprovedExtension, readApproval } from "./compileExtensionModule.js";
import { extensionDisplayName, userExtensionShellToggle, userExtensionToggle } from "./extensionToggles.js";
//#region src/extensions/dynamicExtensions.ts
/**
* Walks the workspace for blocks of `type: 'extension'`, compiles each,
* and returns their default exports as a single AppExtension subtree.
*
* Block-author authorship contract:
*   - The block is TS/JSX. It runs through Babel (react + typescript
*     presets) and is loaded as an ESM module via blob URL.
*   - `module.default` must be a valid AppExtension:
*     a FacetContribution, an array of AppExtension, an async/sync
*     function returning AppExtension, or nullish/false.
*   - Imports work through the page-global importmap. `import { x }
*     from '@/extensions/api.js'` returns the *same* module instance
*     the running app uses, so contribution facets match by identity.
*   - Display metadata comes from extension block properties, not
*     executable module code. That keeps settings rows descriptive
*     even when a block is disabled and intentionally not compiled.
*
* Provenance: every contribution emitted from a block has its `source`
* field force-prefixed with `block:<id>`. If the author supplied a
* source, it becomes `block:<id>/<author-source>`. This makes the
* agent-bridge `describeRuntime` payload show contribution origin
* unambiguously.
*
* Two-gate enable model (issue #67):
*   - Gate 1 — intent: the synced `overrides` map. A block the user hasn't
*     enabled (or any block in safe mode) is skipped without compiling, so
*     its top-level module code never runs.
*   - Gate 2 — device-local trust: even when intent is true, a block runs
*     only if THIS device holds an approval record, and it runs the
*     approval's PINNED output — never the live `block.content`. So a
*     source change synced from elsewhere can't silently execute new code:
*       · no approval here → emit a shell + report `needs-approval`
*         ("Enable here" reviews + approves the live source).
*       · live source drifted from the pin → keep running the pinned
*         version + report `update-available` ("Update" re-approves).
*
* Toggle integration: each running extension is wrapped in a
* `userExtensionToggle(block)` boundary so the runtime resolver can
* disable it without re-loading. Skipped / not-approved / broken blocks
* emit `userExtensionShellToggle(block).of([])` so the row still appears
* in the settings tree and stays user-recoverable.
*
* Failure isolation: a block whose source fails to compile or whose
* default export is shaped wrong is reported via `errorReporter` and
* replaced with a shell — other extensions still load.
*/
var dynamicExtensionsExtension = (options) => async () => {
	const { repo, workspaceId, safeMode, overrides, errorReporter, approvalStatusReporter, cache, persistent, verifyLiveSource } = options;
	const effectiveOverrides = overrides ?? /* @__PURE__ */ new Map();
	const resolveBlockModule = async (block) => {
		if (verifyLiveSource) return (await compileForVerification(block.content, block.id, cache)).module;
		const approval = await readApproval(block.id, persistent);
		if (!approval) {
			approvalStatusReporter?.(block.id, {
				kind: "needs-approval",
				name: extensionDisplayName(block),
				liveHash: await hashExtensionSource(block.content)
			});
			return null;
		}
		const liveHash = await hashExtensionSource(block.content);
		if (liveHash !== approval.sourceHash) approvalStatusReporter?.(block.id, {
			kind: "update-available",
			name: extensionDisplayName(block),
			liveHash,
			approvedHash: approval.sourceHash
		});
		return (await loadApprovedExtension(block.id, approval, cache, persistent)).module;
	};
	let extensionBlocks;
	try {
		extensionBlocks = await repo.query.findExtensionBlocks({ workspaceId }).load();
	} catch (error) {
		console.error("Failed to query extension blocks", error);
		return [];
	}
	const collected = [];
	for (const block of extensionBlocks) {
		const shell = userExtensionShellToggle(block);
		if (safeMode || !isEnabled(shell, effectiveOverrides)) {
			collected.push(shell.of([]));
			continue;
		}
		try {
			const module = await resolveBlockModule(block);
			if (module === null) {
				collected.push(shell.of([]));
				continue;
			}
			const exported = module.default;
			const validated = validateAndPrefix(userExtensionToggle(block).of(exported), block.id);
			collected.push(validated ?? shell.of([]));
		} catch (error) {
			const wrapped = error instanceof Error ? error : new Error(String(error));
			errorReporter?.(block.id, wrapped);
			console.error(`Failed to load extension block ${block.id}`, wrapped);
			collected.push(shell.of([]));
		}
	}
	return collected;
};
/**
* Walks an AppExtension tree, validates shape, and force-prefixes every
* FacetContribution's `source`.
*
* Returns a normalized AppExtension on success; throws on shape errors so
* the caller can attribute them to the offending block.
*
* **Boundary preservation:** when the input array carries a togglable
* BOUNDARY symbol (attached by `userExtensionToggle(block).of(...)`),
* the freshly-mapped array also gets the symbol. Without this,
* `.map()` would drop the marker, leaving the dynamic subtree
* untoggleable by the resolver — every disable would no-op.
*/
var validateAndPrefix = (extension, blockId) => {
	if (extension === null || extension === void 0 || extension === false) return null;
	if (Array.isArray(extension)) {
		const mapped = extension.map((child) => validateAndPrefix(child, blockId));
		const boundary = getBoundary(extension);
		if (boundary) attachBoundary(mapped, boundary);
		return mapped;
	}
	if (typeof extension === "function") return async (context) => {
		return validateAndPrefix(await extension(context), blockId);
	};
	if (isFacetContribution(extension)) return prefixContributionSource(extension, blockId);
	throw new Error(`Extension default export has invalid shape: ${describeShape(extension)}. Expected a FacetContribution, an array of AppExtension, a function returning AppExtension, or null/undefined/false.`);
};
/** Prefix the contribution's `source` with `block:<id>` (composing
*  with any author-supplied source) AND recurse into `enables` so
*  dragged-along contributions get the same provenance treatment as
*  the top-level export. Without the `enables` recursion, a nested
*  contribution would bypass validateAndPrefix entirely — keeping its
*  original source string and skipping any per-contribution
*  validation. The resolver itself walks `enables`, so production
*  would happily register an attributed-to-nobody contribution. */
var prefixContributionSource = (contribution, blockId) => {
	const blockSource = `block:${blockId}`;
	const composed = contribution.source ? `${blockSource}/${contribution.source}` : blockSource;
	const result = {
		...contribution,
		source: composed
	};
	if (contribution.enables !== void 0) result.enables = validateAndPrefix(contribution.enables, blockId);
	return result;
};
var describeShape = (value) => {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
};
//#endregion
export { dynamicExtensionsExtension };

//# sourceMappingURL=dynamicExtensions.js.map