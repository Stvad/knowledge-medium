import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { outlineRenderScopeId } from "./renderScope.js";
import { activePanelIdProp, focusedBlockLocationProp, hasBlockType, scrollTopProp, topLevelBlockIdProp } from "../data/properties.js";
import { PANEL_STACK_TYPE, PANEL_TYPE } from "../data/blockTypes.js";
import { keyAtEnd, keyBetween, keysBetween } from "../data/orderKey.js";
import { keysImmediatelyAfter } from "../data/orderKeyPlacement.js";
import { CallbackSet } from "./callbackSet.js";
import { buildLayoutFromSlots, parseLayout, preserveHashQueryParams } from "./routing.js";
import { panelHistory, writePanelContent } from "./panelHistory.js";
//#region src/utils/panelLayoutProjection.ts
var isPanelStackRow = (row) => hasBlockType(row, PANEL_STACK_TYPE);
var panelBlockId = (row) => {
	const stored = row.properties[topLevelBlockIdProp.name];
	if (stored === void 0) return void 0;
	return topLevelBlockIdProp.codec.decode(stored);
};
var panelBlockIds = (rows) => rows.map(panelBlockId).filter((id) => Boolean(id));
/** Group rows by `parentId`, preserving row order within each parent.
*  Rows without a parent are skipped (we never want an `undefined` bucket). */
var buildChildrenByParent = (rows) => {
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const row of rows) {
		if (!row.parentId) continue;
		const children = childrenByParent.get(row.parentId) ?? [];
		children.push(row);
		childrenByParent.set(row.parentId, children);
	}
	return childrenByParent;
};
var panelRowsInLayoutOrder = (rootId, rows) => {
	const childrenByParent = buildChildrenByParent(rows);
	const visit = (row) => isPanelStackRow(row) ? (childrenByParent.get(row.id) ?? []).flatMap(visit) : [row];
	return (childrenByParent.get(rootId) ?? []).flatMap(visit);
};
var flattenLayoutSlots = (slots) => slots.flatMap((slot) => slot.kind === "leaf" ? [slot.blockId] : flattenLayoutSlots(slot.children));
var sameLayoutSlots = (left, right) => left.length === right.length && left.every((slot, index) => {
	const other = right[index];
	if (!other || slot.kind !== other.kind) return false;
	if (slot.kind === "leaf" && other.kind === "leaf") return slot.blockId === other.blockId;
	if (slot.kind === "stack" && other.kind === "stack") return sameLayoutSlots(slot.children, other.children);
	return false;
});
var layoutSlotsFromRows = (rootId, rows) => {
	const childrenByParent = buildChildrenByParent(rows);
	const visit = (row) => {
		if (isPanelStackRow(row)) return {
			kind: "stack",
			children: (childrenByParent.get(row.id) ?? []).map(visit).filter((slot) => Boolean(slot))
		};
		const blockId = panelBlockId(row);
		return blockId ? {
			kind: "leaf",
			blockId
		} : null;
	};
	return (childrenByParent.get(rootId) ?? []).map(visit).filter((slot) => Boolean(slot));
};
var layoutBlockIdsFromRows = (rootId, rows) => flattenLayoutSlots(layoutSlotsFromRows(rootId, rows));
var loadSubtreeRowsInTx = async (tx, root) => {
	const rows = [root];
	const visit = async (parentId) => {
		const children = await tx.childrenOf(parentId, root.workspaceId);
		for (const child of children) {
			rows.push(child);
			await visit(child.id);
		}
	};
	await visit(root.id);
	return rows;
};
var lcsMatches = (current, targetBlockIds) => {
	const table = Array.from({ length: current.length + 1 }, () => Array.from({ length: targetBlockIds.length + 1 }, () => 0));
	for (let i = current.length - 1; i >= 0; i--) for (let j = targetBlockIds.length - 1; j >= 0; j--) table[i][j] = current[i].blockId === targetBlockIds[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
	const matches = [];
	let i = 0;
	let j = 0;
	while (i < current.length && j < targetBlockIds.length) if (current[i].blockId === targetBlockIds[j]) {
		matches.push({
			currentIndex: i,
			targetIndex: j
		});
		i++;
		j++;
	} else if (table[i + 1][j] >= table[i][j + 1]) i++;
	else j++;
	return matches;
};
var planReconciliation = (current, targetBlockIds) => {
	const rowsByTargetIndex = /* @__PURE__ */ new Map();
	const matches = lcsMatches(current, targetBlockIds);
	const usedCurrent = /* @__PURE__ */ new Set();
	for (const match of matches) {
		rowsByTargetIndex.set(match.targetIndex, current[match.currentIndex]);
		usedCurrent.add(match.currentIndex);
	}
	for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
		if (rowsByTargetIndex.has(targetIndex)) continue;
		const exactIndex = current.findIndex((slot, currentIndex) => !usedCurrent.has(currentIndex) && slot.blockId === targetBlockIds[targetIndex]);
		if (exactIndex >= 0) {
			rowsByTargetIndex.set(targetIndex, current[exactIndex]);
			usedCurrent.add(exactIndex);
		}
	}
	for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
		if (rowsByTargetIndex.has(targetIndex)) continue;
		const reusableIndex = current.findIndex((_, currentIndex) => !usedCurrent.has(currentIndex));
		if (reusableIndex >= 0) {
			rowsByTargetIndex.set(targetIndex, current[reusableIndex]);
			usedCurrent.add(reusableIndex);
		}
	}
	return {
		rowsByTargetIndex,
		rowsToDelete: current.filter((_, currentIndex) => !usedCurrent.has(currentIndex))
	};
};
var createPanelRowInTx = async (repo, tx, args) => {
	const id = await tx.create({
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		orderKey: args.orderKey,
		content: args.blockId,
		properties: {
			[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(args.blockId),
			[focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
				blockId: args.blockId,
				renderScopeId: outlineRenderScopeId(args.blockId)
			}),
			[scrollTopProp.name]: scrollTopProp.codec.encode(0)
		}
	});
	await repo.addTypeInTx(tx, id, PANEL_TYPE);
	return id;
};
var createPanelStackRowInTx = async (repo, tx, args) => {
	const id = await tx.create({
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		orderKey: args.orderKey,
		content: "sidebar-stack",
		properties: {}
	});
	await repo.addTypeInTx(tx, id, PANEL_STACK_TYPE);
	return id;
};
var insertPanelRow = async (repo, layoutSessionBlock, blockId, options = {}) => repo.tx(async (tx) => {
	const parent = await tx.get(layoutSessionBlock.id);
	if (!parent) throw new Error(`insertPanelRow: layout session block ${layoutSessionBlock.id} not found`);
	const siblings = await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId);
	const sourceIndex = options.afterPanelId ? siblings.findIndex((row) => row.id === options.afterPanelId) : -1;
	const orderKey = sourceIndex >= 0 ? (await keysImmediatelyAfter(tx, layoutSessionBlock.id, siblings, sourceIndex, 1))[0] : keyAtEnd(siblings.at(-1)?.orderKey ?? null);
	const panelId = await createPanelRowInTx(repo, tx, {
		workspaceId: parent.workspaceId,
		parentId: layoutSessionBlock.id,
		orderKey,
		blockId
	});
	await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId);
	return panelId;
}, {
	scope: ChangeScope.UiState,
	description: "insert panel row"
});
var insertPanelAtStartOfStackInTx = async (repo, tx, args) => {
	const orderKey = keyBetween(null, (await tx.childrenOf(args.stackId, args.workspaceId))[0]?.orderKey ?? null);
	return createPanelRowInTx(repo, tx, {
		workspaceId: args.workspaceId,
		parentId: args.stackId,
		orderKey,
		blockId: args.blockId
	});
};
var insertSidebarStackedPanel = async (repo, layoutSessionBlock, blockId, options = {}) => repo.tx(async (tx) => {
	const parent = await tx.get(layoutSessionBlock.id);
	if (!parent) throw new Error(`insertSidebarStackedPanel: layout session block ${layoutSessionBlock.id} not found`);
	if (options.sourcePanelId) {
		const source = await tx.get(options.sourcePanelId);
		const sourceParent = source?.parentId ? await tx.get(source.parentId) : null;
		if (source && sourceParent && isPanelStackRow(sourceParent)) {
			const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
				workspaceId: parent.workspaceId,
				stackId: sourceParent.id,
				blockId
			});
			await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId);
			return panelId;
		}
		if (source?.parentId === layoutSessionBlock.id) {
			const topLevelSiblings = await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId);
			const sourceIndex = topLevelSiblings.findIndex((row) => row.id === source.id);
			const rightSibling = sourceIndex >= 0 ? topLevelSiblings[sourceIndex + 1] : void 0;
			if (rightSibling && isPanelStackRow(rightSibling)) {
				const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
					workspaceId: parent.workspaceId,
					stackId: rightSibling.id,
					blockId
				});
				await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId);
				return panelId;
			}
			const stackOrderKey = rightSibling ? rightSibling.orderKey : keyAtEnd(source.orderKey);
			const stackId = await createPanelStackRowInTx(repo, tx, {
				workspaceId: parent.workspaceId,
				parentId: layoutSessionBlock.id,
				orderKey: stackOrderKey
			});
			if (rightSibling) {
				const [, rightOrderKey] = keysBetween(null, null, 2);
				await tx.move(rightSibling.id, {
					parentId: stackId,
					orderKey: rightOrderKey
				});
			}
			const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
				workspaceId: parent.workspaceId,
				stackId,
				blockId
			});
			await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId);
			return panelId;
		}
	}
	const previous = (await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId)).at(-1);
	const stackId = await createPanelStackRowInTx(repo, tx, {
		workspaceId: parent.workspaceId,
		parentId: layoutSessionBlock.id,
		orderKey: keyAtEnd(previous?.orderKey ?? null)
	});
	const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
		workspaceId: parent.workspaceId,
		stackId,
		blockId
	});
	await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId);
	return panelId;
}, {
	scope: ChangeScope.UiState,
	description: "insert sidebar stack panel"
});
var deletePanelRow = async (repo, panelId) => {
	panelHistory.clear(panelId);
	await repo.tx(async (tx) => {
		const row = await tx.get(panelId);
		if (!row) return;
		const parent = row.parentId ? await tx.get(row.parentId) : null;
		const layoutSessionId = parent && isPanelStackRow(parent) ? parent.parentId : row.parentId;
		const layoutSession = layoutSessionId ? await tx.get(layoutSessionId) : null;
		const stackSiblingCount = parent && isPanelStackRow(parent) ? (await tx.childrenOf(parent.id, parent.workspaceId)).length : 0;
		await tx.delete(panelId);
		if (parent && isPanelStackRow(parent) && stackSiblingCount <= 1) await tx.delete(parent.id);
		if (layoutSession?.properties[activePanelIdProp.name] === panelId) {
			const rows = await loadSubtreeRowsInTx(tx, layoutSession);
			const nextActivePanelId = panelRowsInLayoutOrder(layoutSession.id, rows).at(-1)?.id;
			await tx.setProperty(layoutSession.id, activePanelIdProp, nextActivePanelId);
		}
	}, {
		scope: ChangeScope.UiState,
		description: "close panel"
	});
};
var reconcilePanelRows = async (repo, layoutSessionBlock, targetSlotsOrBlockIds) => {
	const targetSlots = targetSlotsOrBlockIds.map((slot) => typeof slot === "string" ? {
		kind: "leaf",
		blockId: slot
	} : slot);
	const targetBlockIds = flattenLayoutSlots(targetSlots);
	await repo.tx(async (tx) => {
		const parent = await tx.get(layoutSessionBlock.id);
		if (!parent) throw new Error(`reconcilePanelRows: layout session block ${layoutSessionBlock.id} not found`);
		const currentRows = await loadSubtreeRowsInTx(tx, parent);
		if (sameLayoutSlots(layoutSlotsFromRows(layoutSessionBlock.id, currentRows), targetSlots)) return;
		const currentSlots = currentRows.filter((row) => row.id !== layoutSessionBlock.id && !isPanelStackRow(row)).map((row) => ({
			row,
			blockId: panelBlockId(row)
		}));
		const stackRowsToDelete = currentRows.filter((row) => row.id !== layoutSessionBlock.id && isPanelStackRow(row));
		const { rowsByTargetIndex, rowsToDelete } = planReconciliation(currentSlots, targetBlockIds);
		for (const slot of rowsToDelete) {
			panelHistory.clear(slot.row.id);
			await tx.delete(slot.row.id);
		}
		let targetLeafIndex = 0;
		const materializeSlots = async (slots, parentId) => {
			const orderKeys = keysBetween(null, null, slots.length);
			for (let index = 0; index < slots.length; index++) {
				const target = slots[index];
				const orderKey = orderKeys[index];
				if (target.kind === "stack") {
					const stackId = await createPanelStackRowInTx(repo, tx, {
						workspaceId: parent.workspaceId,
						parentId,
						orderKey
					});
					await materializeSlots(target.children, stackId);
					continue;
				}
				const blockId = target.blockId;
				const slot = rowsByTargetIndex.get(targetLeafIndex);
				targetLeafIndex++;
				if (!slot) {
					await createPanelRowInTx(repo, tx, {
						workspaceId: parent.workspaceId,
						parentId,
						orderKey,
						blockId
					});
					continue;
				}
				if (slot.row.orderKey !== orderKey || slot.row.parentId !== parentId) await tx.move(slot.row.id, {
					parentId,
					orderKey
				});
				if (slot.blockId !== blockId) {
					const restored = slot.blockId ? panelHistory.reconcileUrlNavigation(slot.row.id, {
						blockId: slot.blockId,
						state: panelHistory.snapshot(slot.row.id)
					}, blockId) : null;
					panelHistory.enqueueRestore(slot.row.id, restored?.state);
					await writePanelContent(tx, slot.row.id, blockId, restored?.state);
				}
			}
		};
		await materializeSlots(targetSlots, layoutSessionBlock.id);
		for (const stackRow of stackRowsToDelete) await tx.delete(stackRow.id);
	}, {
		scope: ChangeScope.UiState,
		description: "reconcile panel layout from URL"
	});
};
var retargetPanelBlockIds = async (repo, layoutSessionBlock, fromId, toId) => {
	if (fromId === toId) return;
	await repo.tx(async (tx) => {
		const parent = await tx.get(layoutSessionBlock.id);
		if (!parent) throw new Error(`retargetPanelBlockIds: layout session block ${layoutSessionBlock.id} not found`);
		const panelRows = (await loadSubtreeRowsInTx(tx, parent)).filter((row) => row.id !== layoutSessionBlock.id && !isPanelStackRow(row)).filter((row) => panelBlockId(row) === fromId);
		for (const row of panelRows) {
			const restored = panelHistory.reconcileUrlNavigation(row.id, {
				blockId: fromId,
				state: panelHistory.snapshot(row.id)
			}, toId);
			panelHistory.enqueueRestore(row.id, restored?.state);
			await writePanelContent(tx, row.id, toId, restored?.state);
		}
	}, {
		scope: ChangeScope.UiState,
		description: "retarget merged panels"
	});
};
var applyCurrentLayoutUrl = async ({ repo, workspaceId, layoutSessionBlock, hash = typeof window === "undefined" ? "" : window.location.hash, replaceHash }) => {
	const route = parseLayout(hash);
	if (route.workspaceId && route.workspaceId !== workspaceId) return { kind: "ignored" };
	const currentRows = await layoutSessionBlock.repo.query.subtree({ id: layoutSessionBlock.id }).load();
	const currentSlots = layoutSlotsFromRows(layoutSessionBlock.id, currentRows);
	if (route.slots.length === 0) {
		if (currentSlots.length > 0) {
			replaceHash?.(preserveHashQueryParams(buildLayoutFromSlots(workspaceId, currentSlots), hash));
			return { kind: "normalized" };
		}
		return { kind: "empty" };
	}
	if (sameLayoutSlots(currentSlots, route.slots)) return { kind: "noop" };
	await reconcilePanelRows(repo, layoutSessionBlock, route.slots);
	return { kind: "applied" };
};
var defaultGetHash = () => window.location.hash;
var defaultPushHash = (hash) => {
	window.history.pushState(null, "", preserveHashQueryParams(hash, window.location.hash));
};
var defaultReplaceHash = (hash) => {
	window.history.replaceState(null, "", preserveHashQueryParams(hash, window.location.hash));
};
var defaultSubscribeToUrl = (listener) => {
	window.addEventListener("hashchange", listener);
	window.addEventListener("popstate", listener);
	return () => {
		window.removeEventListener("hashchange", listener);
		window.removeEventListener("popstate", listener);
	};
};
var PanelLayoutProjection = class {
	repo;
	workspaceId;
	layoutSessionBlock;
	getHash;
	pushHash;
	replaceHash;
	subscribeToUrl;
	listeners = new CallbackSet("PanelLayoutProjection");
	unsubscribeRows = null;
	unsubscribeUrl = null;
	inboundQueue = Promise.resolve();
	lastSlots = [];
	constructor(options) {
		this.repo = options.repo;
		this.workspaceId = options.workspaceId;
		this.layoutSessionBlock = options.layoutSessionBlock;
		this.getHash = options.getHash ?? defaultGetHash;
		this.pushHash = options.pushHash ?? defaultPushHash;
		this.replaceHash = options.replaceHash ?? defaultReplaceHash;
		this.subscribeToUrl = options.subscribeToUrl ?? defaultSubscribeToUrl;
	}
	async start() {
		if (this.unsubscribeRows || this.unsubscribeUrl) return;
		const rowsHandle = this.layoutSessionBlock.repo.query.subtree({ id: this.layoutSessionBlock.id });
		const initialRows = await rowsHandle.load();
		this.lastSlots = layoutSlotsFromRows(this.layoutSessionBlock.id, initialRows);
		this.unsubscribeRows = rowsHandle.subscribe((rows) => {
			this.handleRowsChanged(rows);
		});
		this.unsubscribeUrl = this.subscribeToUrl(() => {
			this.applyCurrentUrl();
		});
	}
	dispose() {
		this.unsubscribeRows?.();
		this.unsubscribeRows = null;
		this.unsubscribeUrl?.();
		this.unsubscribeUrl = null;
		this.listeners.clear();
	}
	subscribe(listener) {
		return this.listeners.add(listener);
	}
	applyCurrentUrl() {
		this.inboundQueue = this.inboundQueue.catch(() => {}).then(async () => {
			const result = await applyCurrentLayoutUrl({
				repo: this.repo,
				workspaceId: this.workspaceId,
				layoutSessionBlock: this.layoutSessionBlock,
				hash: this.getHash(),
				replaceHash: (hash) => {
					this.replaceHash(hash);
					this.listeners.notify();
				}
			});
			if (result.kind === "applied" || result.kind === "normalized" || result.kind === "ignored") this.listeners.notify();
		});
		return this.inboundQueue;
	}
	handleRowsChanged(rows) {
		const slots = layoutSlotsFromRows(this.layoutSessionBlock.id, rows);
		if (sameLayoutSlots(this.lastSlots, slots)) return;
		this.lastSlots = slots;
		const nextHash = buildLayoutFromSlots(this.workspaceId, slots);
		if (this.getHash() === nextHash) return;
		this.pushHash(nextHash);
		this.listeners.notify();
	}
};
//#endregion
export { PanelLayoutProjection, applyCurrentLayoutUrl, createPanelRowInTx, createPanelStackRowInTx, deletePanelRow, insertPanelRow, insertSidebarStackedPanel, isPanelStackRow, layoutBlockIdsFromRows, layoutSlotsFromRows, panelBlockId, panelBlockIds, panelRowsInLayoutOrder, reconcilePanelRows, retargetPanelBlockIds };

//# sourceMappingURL=panelLayoutProjection.js.map