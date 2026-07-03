import { ChangeScope } from "./api/changeScope.js";
import { BlockNotFoundError } from "./api/errors.js";
import { CORE_BLOCK_DELETED_EVENT } from "./api/events.js";
import { defineMutator } from "./api/mutator.js";
import { array, boolean, discriminatedUnion, literal, object, record, string, union, unknown } from "../../node_modules/zod/v4/classic/schemas.js";
import "./api/index.js";
import { isCollapsedProp } from "./properties.js";
import { keyAtEnd, keyAtStart, keyBetween, keysBetween } from "./orderKey.js";
import { keyImmediatelyAfter, keyImmediatelyBefore, keysImmediatelyAfter, keysImmediatelyBefore } from "./orderKeyPlacement.js";
import { mergeBlocksInTx } from "./blockMerge.js";
//#region src/data/mutators.ts
/**
* Kernel tree mutators (spec §13.3). Each is registered as a `Mutator`
* via `defineMutator` and dispatched from `repo.mutate.X(args)` or
* `repo.run('name', args)`.
*
* All mutators run inside a `repo.tx` (the dispatch wrapper opens one
* automatically with the mutator's scope) and use the public Tx
* primitives plus the tree CTEs from stage 1.3. Order keys are
* computed via `fractional-indexing-jittered` (§4.7 / §16.12).
*
* Subtree handling note: legacy `Block.delete()` cascaded a soft-delete
* across descendants; the new `delete` mutator preserves that behavior
* via DFS over `tx.childrenOf`. Walking by repeated child-queries keeps
* us on the public Tx surface (no raw SQL needed inside mutators); the
* round-trips are bounded by tree depth, which is small in practice.
*/
/** Read a block; throws BlockNotFoundError. Used by mutators that need
*  more than the bare id (workspace lookup, sibling lookup, etc). */
var requireBlock = async (tx, id) => {
	const data = await tx.get(id);
	if (data === null) throw new BlockNotFoundError(id);
	return data;
};
var orderKeyAfterSibling = (tx, sibling) => orderKeyForInsert(tx, sibling.parentId, sibling.workspaceId, {
	kind: "after",
	siblingId: sibling.id
});
var orderKeyBeforeSibling = (tx, sibling) => orderKeyForInsert(tx, sibling.parentId, sibling.workspaceId, {
	kind: "before",
	siblingId: sibling.id
});
/** Compute the order_key for placing a block under `parentId` at a given
*  `position`. Reads sibling list from SQL (tx.childrenOf is sorted by
*  (order_key, id) per §11.4). `parentId === null` enumerates
*  workspace-root siblings; the caller passes `workspaceId` explicitly
*  so the lookup is scoped correctly even before the tx has pinned a
*  workspace via a write (kernel mutators read the sibling/parent row
*  first and have the workspace in hand at that point).
*
*  `{before,after}` place the block EXACTLY adjacent to the anchor (between it
*  and its neighbour on that side), breaking a tie by re-keying the run when one
*  blocks the slot — so this MAY write to sibling rows (see `orderKeyPlacement`).
*  Pass `excludeId` when relocating an EXISTING block (so it isn't treated as a
*  sibling of itself / re-keyed by the move). */
var orderKeyForInsert = async (tx, parentId, workspaceId, position, excludeId) => {
	const all = await tx.childrenOf(parentId, workspaceId);
	const siblings = excludeId === void 0 ? all : all.filter((s) => s.id !== excludeId);
	if (position.kind === "first") return keyAtStart(siblings[0]?.orderKey ?? null);
	if (position.kind === "last") return keyAtEnd(siblings.at(-1)?.orderKey ?? null);
	const ix = siblings.findIndex((s) => s.id === position.siblingId);
	if (ix < 0) throw new Error(`position.${position.kind === "after" ? "after" : "before"} sibling ${position.siblingId} not found under ${parentId ?? "root"}`);
	return position.kind === "after" ? keyImmediatelyAfter(tx, parentId, siblings, ix) : keyImmediatelyBefore(tx, parentId, siblings, ix);
};
var positionSchema = discriminatedUnion("kind", [
	object({ kind: literal("first") }),
	object({ kind: literal("last") }),
	object({
		kind: literal("after"),
		siblingId: string()
	}),
	object({
		kind: literal("before"),
		siblingId: string()
	})
]);
/** Re-home `block` under `parentId` at `position`, computing the order
*  key. The shared core of `core.move` (explicit placement) and
*  `moveVertical`'s cross-parent edge case — both funnel their final write
*  through here. `block.id` is excluded from the sibling list so a same-parent
*  move places the block relative to the OTHER siblings (and the tie-break
*  re-key never moves the block out from under itself). */
var relocateBlock = async (tx, block, parentId, position) => {
	const orderKey = await orderKeyForInsert(tx, parentId, block.workspaceId, position, block.id);
	await tx.move(block.id, {
		parentId,
		orderKey
	});
};
/** Reveal a block's children by clearing a collapsed flag. Structural
*  placements that put a block *as a child of* `id` call this so the
*  inserted/moved block can't land inside a closed subtree and vanish.
*  The shared invariant behind indent (reparent under previous sibling),
*  moveVertical (descend into a neighbour), child-first create-below
*  (vim `o` / Enter on a collapsed scope root), and paste-as-child.
*  No-op when not collapsed. */
var revealChildren = async (tx, id) => {
	if (await tx.getProperty(id, isCollapsedProp)) await tx.setProperty(id, isCollapsedProp, false);
};
var setContent = defineMutator({
	name: "core.setContent",
	argsSchema: object({
		id: string(),
		content: string()
	}),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `set content on ${id}`,
	apply: async (tx, { id, content }) => {
		await tx.update(id, { content });
	}
});
var setProperty = defineMutator({
	name: "core.setProperty",
	argsSchema: object({
		id: string(),
		schema: unknown(),
		value: unknown()
	}),
	scope: ({ schema }) => schema.changeScope,
	describe: ({ id, schema }) => `set property ${schema.name} on ${id}`,
	apply: async (tx, { id, schema, value }) => {
		await tx.setProperty(id, schema, value);
	}
});
/** DFS walk via tx.childrenOf, calling tx.delete on each visited block.
*  Iterative + explicit stack to avoid blowing the JS recursion limit
*  on deep trees.
*
*  Each freshly soft-deleted block emits `CORE_BLOCK_DELETED_EVENT` so
*  same-tx consumers can react atomically with the delete — the
*  references plugin uses it to inline a deleted block's content into the
*  blocks that referenced it (`((id))`), keeping those referrers readable
*  instead of leaving dangling block-refs. We carry the `BlockData` from
*  `childrenOf` (and one `tx.get` for the root) so the walk doesn't pay an
*  extra per-node read just to recover `workspaceId`; the `!deleted` guard
*  only ever skips an already-tombstoned root (children come back live). */
var softDeleteSubtree = async (tx, rootId) => {
	const root = await tx.get(rootId);
	if (root === null) {
		await tx.delete(rootId);
		return;
	}
	const stack = [root];
	const seen = /* @__PURE__ */ new Set();
	while (stack.length > 0) {
		const block = stack.pop();
		if (seen.has(block.id)) continue;
		seen.add(block.id);
		const children = await tx.childrenOf(block.id);
		for (const c of children) stack.push(c);
		await tx.delete(block.id);
		if (!block.deleted) tx.emitEvent(CORE_BLOCK_DELETED_EVENT, {
			workspaceId: block.workspaceId,
			blockId: block.id
		});
	}
};
var deleteBlock = defineMutator({
	name: "core.delete",
	argsSchema: object({ id: string() }),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `delete ${id} (subtree)`,
	apply: async (tx, { id }) => {
		await softDeleteSubtree(tx, id);
	}
});
var createChild = defineMutator({
	name: "core.createChild",
	argsSchema: object({
		parentId: string(),
		content: string().optional(),
		properties: record(string(), unknown()).optional(),
		references: array(object({
			id: string(),
			alias: string()
		})).optional(),
		position: positionSchema.optional(),
		id: string().optional(),
		revealParent: boolean().optional()
	}),
	resultSchema: string(),
	scope: ChangeScope.BlockDefault,
	describe: ({ parentId }) => `create child under ${parentId}`,
	apply: async (tx, args) => {
		const parent = await requireBlock(tx, args.parentId);
		const orderKey = await orderKeyForInsert(tx, args.parentId, parent.workspaceId, args.position ?? { kind: "last" });
		if (args.revealParent) await revealChildren(tx, args.parentId);
		return tx.create({
			id: args.id,
			workspaceId: parent.workspaceId,
			parentId: args.parentId,
			orderKey,
			content: args.content ?? "",
			properties: args.properties,
			references: args.references
		});
	}
});
var siblingArgsSchema = object({
	siblingId: string(),
	content: string().optional(),
	properties: record(string(), unknown()).optional(),
	references: array(object({
		id: string(),
		alias: string()
	})).optional(),
	id: string().optional()
});
var createSiblingAbove = defineMutator({
	name: "core.createSiblingAbove",
	argsSchema: siblingArgsSchema,
	resultSchema: string(),
	scope: ChangeScope.BlockDefault,
	describe: ({ siblingId }) => `create sibling above ${siblingId}`,
	apply: async (tx, args) => {
		const sibling = await requireBlock(tx, args.siblingId);
		const orderKey = await orderKeyBeforeSibling(tx, sibling);
		return tx.create({
			id: args.id,
			workspaceId: sibling.workspaceId,
			parentId: sibling.parentId,
			orderKey,
			content: args.content ?? "",
			properties: args.properties,
			references: args.references
		});
	}
});
var createSiblingBelow = defineMutator({
	name: "core.createSiblingBelow",
	argsSchema: siblingArgsSchema,
	resultSchema: string(),
	scope: ChangeScope.BlockDefault,
	describe: ({ siblingId }) => `create sibling below ${siblingId}`,
	apply: async (tx, args) => {
		const sibling = await requireBlock(tx, args.siblingId);
		const orderKey = await orderKeyAfterSibling(tx, sibling);
		return tx.create({
			id: args.id,
			workspaceId: sibling.workspaceId,
			parentId: sibling.parentId,
			orderKey,
			content: args.content ?? "",
			properties: args.properties,
			references: args.references
		});
	}
});
var insertChildren = defineMutator({
	name: "core.insertChildren",
	argsSchema: object({
		parentId: string(),
		items: array(object({
			id: string().optional(),
			content: string().optional(),
			properties: record(string(), unknown()).optional(),
			references: array(object({
				id: string(),
				alias: string()
			})).optional()
		})),
		position: positionSchema.optional()
	}),
	resultSchema: array(string()),
	scope: ChangeScope.BlockDefault,
	describe: ({ parentId, items }) => `insert ${items.length} children under ${parentId}`,
	apply: async (tx, args) => {
		if (args.items.length === 0) return [];
		const parent = await requireBlock(tx, args.parentId);
		const siblings = await tx.childrenOf(args.parentId);
		const position = args.position ?? { kind: "last" };
		const n = args.items.length;
		const keys = await (async () => {
			if (position.kind === "first") return keysBetween(null, siblings[0]?.orderKey ?? null, n);
			if (position.kind === "last") return keysBetween(siblings.at(-1)?.orderKey ?? null, null, n);
			const ix = siblings.findIndex((s) => s.id === position.siblingId);
			if (ix < 0) throw new Error(`sibling ${position.siblingId} not found under ${args.parentId}`);
			return position.kind === "after" ? keysImmediatelyAfter(tx, args.parentId, siblings, ix, n) : keysImmediatelyBefore(tx, args.parentId, siblings, ix, n);
		})();
		const ids = [];
		for (let i = 0; i < args.items.length; i++) {
			const item = args.items[i];
			const id = await tx.create({
				id: item.id,
				workspaceId: parent.workspaceId,
				parentId: args.parentId,
				orderKey: keys[i],
				content: item.content ?? "",
				properties: item.properties,
				references: item.references
			});
			ids.push(id);
		}
		return ids;
	}
});
var move = defineMutator({
	name: "core.move",
	argsSchema: object({
		id: string(),
		parentId: string().nullable(),
		position: positionSchema
	}),
	scope: ChangeScope.BlockDefault,
	describe: ({ id, parentId }) => `move ${id} → ${parentId ?? "root"}`,
	apply: async (tx, args) => {
		const self = await requireBlock(tx, args.id);
		if ((args.position.kind === "after" || args.position.kind === "before") && args.position.siblingId === args.id && self.parentId === args.parentId) return;
		await relocateBlock(tx, self, args.parentId, args.position);
	}
});
var setOrderKey = defineMutator({
	name: "core.setOrderKey",
	argsSchema: object({
		id: string(),
		orderKey: string()
	}),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `setOrderKey ${id}`,
	apply: async (tx, { id, orderKey }) => {
		const before = await requireBlock(tx, id);
		await tx.move(id, {
			parentId: before.parentId,
			orderKey
		});
	}
});
var indent = defineMutator({
	name: "core.indent",
	argsSchema: object({ id: string() }),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `indent ${id}`,
	apply: async (tx, { id }) => {
		const self = await requireBlock(tx, id);
		if (self.parentId === null) return;
		const siblings = await tx.childrenOf(self.parentId);
		const ix = siblings.findIndex((s) => s.id === id);
		if (ix <= 0) return;
		const newParent = siblings[ix - 1];
		const orderKey = keyAtEnd((await tx.childrenOf(newParent.id)).at(-1)?.orderKey ?? null);
		await tx.move(id, {
			parentId: newParent.id,
			orderKey
		});
		await revealChildren(tx, newParent.id);
	}
});
var outdent = defineMutator({
	name: "core.outdent",
	argsSchema: object({
		id: string(),
		scopeRootId: string().optional()
	}),
	resultSchema: boolean(),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `outdent ${id}`,
	apply: async (tx, { id, scopeRootId }) => {
		const self = await requireBlock(tx, id);
		if (self.parentId === null) return false;
		if (scopeRootId !== void 0 && self.parentId === scopeRootId) return false;
		const parent = await requireBlock(tx, self.parentId);
		const grandparent = parent.parentId;
		const grandSiblings = await tx.childrenOf(grandparent, self.workspaceId);
		const parentIx = grandSiblings.findIndex((s) => s.id === parent.id);
		let orderKey;
		if (parentIx < 0) orderKey = keyAtEnd(grandSiblings.at(-1)?.orderKey ?? null);
		else orderKey = await keyImmediatelyAfter(tx, grandparent, grandSiblings, parentIx);
		await tx.move(id, {
			parentId: grandparent,
			orderKey
		});
		return true;
	}
});
/**
* Move a block one step up or down in the visible outline, WITHOUT ever
* changing its indentation. Within a sibling list it swaps with the
* adjacent sibling; when it is the first/last child of its parent it
* moves into the neighbouring sibling subtree at the SAME depth it
* already had:
*
*     a            a
*       b            b
*         c            c
*     d     ──▶      e   (move e up → a's last child; e stays depth 1)
*       e          d
*
* Rules (up; down mirrors):
*  - has a previous sibling          → swap before it (same parent);
*  - first child, parent has a
*    previous sibling Q              → become Q's last child — same depth
*                                      the block already had. Q is
*                                      revealed if collapsed, mirroring
*                                      how `indent` reveals a collapsed
*                                      new parent;
*  - first child, parent is itself   → no-op. The only one-step-up slot
*    the first child                   would be a shallower level, and
*                                      moveVertical never outdents.
*
* Indentation is invariant: every move keeps the block at its original
* depth, so it never pops out to / into a shallower or deeper level.
* Bounded by `scopeRootId`: the scope root never moves, and a first/last
* direct child of it won't cross out. Returns whether anything moved so
* callers can no-op cleanly.
*/
var moveVertical = defineMutator({
	name: "core.moveVertical",
	argsSchema: object({
		id: string(),
		direction: union([literal(-1), literal(1)]),
		scopeRootId: string().optional()
	}),
	resultSchema: boolean(),
	scope: ChangeScope.BlockDefault,
	describe: ({ id, direction }) => `move ${id} ${direction === -1 ? "up" : "down"}`,
	apply: async (tx, { id, direction, scopeRootId }) => {
		const self = await requireBlock(tx, id);
		if (self.parentId === null) return false;
		if (scopeRootId !== void 0 && id === scopeRootId) return false;
		const siblings = await tx.childrenOf(self.parentId);
		const idx = siblings.findIndex((s) => s.id === id);
		if (idx === -1) return false;
		const up = direction === -1;
		if (up ? idx > 0 : idx < siblings.length - 1) {
			const adjacent = siblings[up ? idx - 1 : idx + 1];
			const others = siblings.filter((s) => s.id !== id);
			const anchor = others.findIndex((s) => s.id === adjacent.id);
			const orderKey = up ? await keyImmediatelyBefore(tx, self.parentId, others, anchor) : await keyImmediatelyAfter(tx, self.parentId, others, anchor);
			await tx.move(id, {
				parentId: self.parentId,
				orderKey
			});
			return true;
		}
		if (scopeRootId === void 0 || self.parentId === scopeRootId) return false;
		const parent = await requireBlock(tx, self.parentId);
		const parentSiblings = await tx.childrenOf(parent.parentId, self.workspaceId);
		const pIdx = parentSiblings.findIndex((s) => s.id === parent.id);
		const neighbourParent = up ? parentSiblings[pIdx - 1] : parentSiblings[pIdx + 1];
		if (!neighbourParent) return false;
		await revealChildren(tx, neighbourParent.id);
		await relocateBlock(tx, self, neighbourParent.id, up ? { kind: "last" } : { kind: "first" });
		return true;
	}
});
var split = defineMutator({
	name: "core.split",
	argsSchema: object({
		id: string(),
		before: string(),
		after: string()
	}),
	resultSchema: string(),
	scope: ChangeScope.BlockDefault,
	describe: ({ id }) => `split ${id}`,
	apply: async (tx, { id, before, after }) => {
		const self = await requireBlock(tx, id);
		await tx.update(id, { content: after });
		const siblings = await tx.childrenOf(self.parentId, self.workspaceId);
		const ix = siblings.findIndex((s) => s.id === id);
		const orderKey = ix < 0 ? keyBetween(null, self.orderKey) : await keyImmediatelyBefore(tx, self.parentId, siblings, ix);
		return tx.create({
			workspaceId: self.workspaceId,
			parentId: self.parentId,
			orderKey,
			content: before
		});
	}
});
var contentStrategySchema = union([
	literal("concat"),
	literal("keepTarget"),
	object({ separator: string() })
]);
var merge = defineMutator({
	name: "core.merge",
	argsSchema: object({
		intoId: string(),
		fromId: string(),
		contentStrategy: contentStrategySchema.optional()
	}),
	scope: ChangeScope.BlockDefault,
	describe: ({ intoId, fromId }) => `merge ${fromId} → ${intoId}`,
	apply: async (tx, { intoId, fromId, contentStrategy = "concat" }) => {
		await mergeBlocksInTx(tx, {
			into: await requireBlock(tx, intoId),
			from: await requireBlock(tx, fromId),
			contentStrategy
		});
	}
});
/** All kernel mutators in one array — registered with `Repo` by
*  `repo.setFacetRuntime` (or the bootstrapping helper that supplies
*  the facet runtime). Typed as `AnyMutator[]` because the mutators
*  have heterogeneous `Args`/`Result` shapes; precise types stay at
*  the per-mutator definition sites and reach callers through the
*  `MutatorRegistry` augmentation. */
var KERNEL_MUTATORS = [
	setContent,
	setProperty,
	deleteBlock,
	createChild,
	createSiblingAbove,
	createSiblingBelow,
	insertChildren,
	move,
	setOrderKey,
	indent,
	outdent,
	moveVertical,
	split,
	merge
];
//#endregion
export { KERNEL_MUTATORS, createChild, createSiblingAbove, createSiblingBelow, deleteBlock, indent, insertChildren, merge, move, moveVertical, outdent, revealChildren, setContent, setOrderKey, setProperty, split };

//# sourceMappingURL=mutators.js.map