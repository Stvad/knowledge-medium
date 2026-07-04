import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { outlineRenderScopeId } from "./renderScope.js";
import { focusedBlockLocationProp, scrollTopProp, topLevelBlockIdProp } from "../data/properties.js";
import { CallbackSet } from "./callbackSet.js";
import { withMoveTransition } from "./viewTransition.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/utils/panelHistory.ts
var EMPTY = {
	back: [],
	forward: []
};
var PanelHistoryStore = class {
	state = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	snapshotters = /* @__PURE__ */ new Map();
	pendingRestore = /* @__PURE__ */ new Map();
	getSnapshot = (panelId) => this.state.get(panelId) ?? EMPTY;
	subscribe = (panelId, listener) => {
		let set = this.listeners.get(panelId);
		if (!set) {
			set = new CallbackSet(`PanelHistory[${panelId}]`);
			this.listeners.set(panelId, set);
		}
		const off = set.add(listener);
		return () => {
			off();
			if (set.size === 0 && this.listeners.get(panelId) === set) this.listeners.delete(panelId);
		};
	};
	/** Record a transition: about to leave `entry`. Pushes onto back,
	*  clears forward (browser-tab semantics — once you navigate after
	*  going back, the previously-popped forward chain is gone). */
	push(panelId, entry) {
		const current = this.state.get(panelId) ?? EMPTY;
		if (current.back[current.back.length - 1]?.blockId === entry.blockId && current.forward.length === 0) return;
		this.state.set(panelId, {
			back: [...current.back, entry],
			forward: []
		});
		this.notify(panelId);
	}
	/** Pop the most recent back entry. Pushes `currentEntry` onto forward
	*  so a subsequent forward() can return to it. Returns the destination
	*  entry, or null if the back stack is empty. */
	back(panelId, currentEntry) {
		const current = this.state.get(panelId) ?? EMPTY;
		if (current.back.length === 0) return null;
		const next = current.back[current.back.length - 1];
		this.state.set(panelId, {
			back: current.back.slice(0, -1),
			forward: [...current.forward, currentEntry]
		});
		this.notify(panelId);
		return next;
	}
	forward(panelId, currentEntry) {
		const current = this.state.get(panelId) ?? EMPTY;
		if (current.forward.length === 0) return null;
		const next = current.forward[current.forward.length - 1];
		this.state.set(panelId, {
			back: [...current.back, currentEntry],
			forward: current.forward.slice(0, -1)
		});
		this.notify(panelId);
		return next;
	}
	reconcileUrlNavigation(panelId, currentEntry, targetBlockId) {
		const current = this.state.get(panelId) ?? EMPTY;
		const backTop = current.back[current.back.length - 1];
		if (backTop?.blockId === targetBlockId) {
			this.state.set(panelId, {
				back: current.back.slice(0, -1),
				forward: [...current.forward, currentEntry]
			});
			this.notify(panelId);
			return backTop;
		}
		const forwardTop = current.forward[current.forward.length - 1];
		if (forwardTop?.blockId === targetBlockId) {
			this.state.set(panelId, {
				back: [...current.back, currentEntry],
				forward: current.forward.slice(0, -1)
			});
			this.notify(panelId);
			return forwardTop;
		}
		if (current.back.length > 0 || current.forward.length > 0) {
			this.state.delete(panelId);
			this.notify(panelId);
		}
		return null;
	}
	clear(panelId) {
		const had = this.state.has(panelId);
		this.state.delete(panelId);
		this.pendingRestore.delete(panelId);
		if (had) this.notify(panelId);
	}
	/** Register a snapshotter for a panel — a function that reads the
	*  panel's current ephemeral state (focused block, scroll, …) so the
	*  store can capture it before the panel navigates. Returns an
	*  unsubscribe function; multiple registrations replace each other so
	*  remounts are safe. */
	registerSnapshotter(panelId, fn) {
		this.snapshotters.set(panelId, fn);
		return () => {
			if (this.snapshotters.get(panelId) === fn) this.snapshotters.delete(panelId);
		};
	}
	/** Invoke the registered snapshotter for a panel, returning whatever
	*  state it captured. Undefined if no snapshotter is registered (e.g.
	*  panel not mounted) — push() will store the entry without state. */
	snapshot(panelId) {
		return this.snapshotters.get(panelId)?.();
	}
	/** Queue a restore for the next time the panel renderer applies state.
	*  Used by back/forward to hand the popped entry's snapshot to the
	*  renderer; the renderer's post-navigation effect drains it. */
	enqueueRestore(panelId, state) {
		if (!state) {
			this.pendingRestore.delete(panelId);
			return;
		}
		this.pendingRestore.set(panelId, state);
	}
	consumeRestore(panelId) {
		const state = this.pendingRestore.get(panelId);
		if (state) this.pendingRestore.delete(panelId);
		return state;
	}
	notify(panelId) {
		this.listeners.get(panelId)?.notify();
	}
};
var panelHistory = new PanelHistoryStore();
/** Write a panel's content: point `panelId` at `blockId` and set its focus +
*  scroll. With `state` (a back/forward or URL-reconcile restore) it replays the
*  captured focus/scroll; without it the view is fresh — focus the new
*  top-level, scroll to 0. The single choke for content *swaps on an existing
*  panel row* — in-panel navigate, back/forward, URL reconcile, merge retarget;
*  a *newly created* row's initial content is set by `createPanelRowInTx`
*  instead, so a complete "observe every view" seam would hook both. Takes the
*  caller's `tx`, so it composes inside a batch reconcile as well as a single
*  interactive swap. */
var writePanelContent = async (tx, panelId, blockId, state) => {
	await tx.setProperty(panelId, topLevelBlockIdProp, blockId);
	await tx.setProperty(panelId, focusedBlockLocationProp, state?.focusedLocation ?? {
		blockId,
		renderScopeId: outlineRenderScopeId(blockId)
	});
	await tx.setProperty(panelId, scrollTopProp, state?.scrollTop ?? 0);
};
/** Swap a panel's content in its own UiState tx, wrapped in the crossfade —
*  the interactive path (navigate / back / forward). Focus restores
*  synchronously here so the first render of the new top-level already has the
*  right cursor; scroll restore needs the new content rendered first and is
*  handled by the renderer via `consumeRestore()` in a post-render effect. */
var transactPanelContent = (panelBlock, blockId, state, description) => withMoveTransition(async () => {
	await panelBlock.repo.tx(async (tx) => {
		await writePanelContent(tx, panelBlock.id, blockId, state);
	}, {
		scope: ChangeScope.UiState,
		description
	});
});
/** Navigate within a panel: capture the current visit's ephemeral state, push
*  (block, state) onto back, clear forward, then swap the panel's top-level
*  block. No-op when `blockId` already equals the current top-level.
*
*  The panel content fully swaps here — the highest-impact transition in the
*  app — centralised so every navigation path (zoom shortcuts, wikilink clicks,
*  breadcrumb, programmatic) gets the same crossfade without re-wrapping. */
var navigateInPanel = async (panelBlock, blockId) => {
	const prev = panelBlock.peekProperty(topLevelBlockIdProp);
	if (prev === blockId) return;
	if (prev) panelHistory.push(panelBlock.id, {
		blockId: prev,
		state: panelHistory.snapshot(panelBlock.id)
	});
	await transactPanelContent(panelBlock, blockId, void 0, "navigate in panel");
};
/** Step the panel one entry back. Captures the current visit's state onto
*  forward, then restores the destination's snapshot (focused block, scroll). */
var goBackInPanel = async (panelBlock) => {
	const current = panelBlock.peekProperty(topLevelBlockIdProp);
	if (!current) return false;
	const dest = panelHistory.back(panelBlock.id, {
		blockId: current,
		state: panelHistory.snapshot(panelBlock.id)
	});
	if (!dest) return false;
	panelHistory.enqueueRestore(panelBlock.id, dest.state);
	await transactPanelContent(panelBlock, dest.blockId, dest.state, "panel history back");
	return true;
};
var goForwardInPanel = async (panelBlock) => {
	const current = panelBlock.peekProperty(topLevelBlockIdProp);
	if (!current) return false;
	const dest = panelHistory.forward(panelBlock.id, {
		blockId: current,
		state: panelHistory.snapshot(panelBlock.id)
	});
	if (!dest) return false;
	panelHistory.enqueueRestore(panelBlock.id, dest.state);
	await transactPanelContent(panelBlock, dest.blockId, dest.state, "panel history forward");
	return true;
};
/** React hook surfacing per-panel back/forward availability for UI
*  affordances. Re-renders the consumer when the panel's stack changes. */
var usePanelHistory = (panelId) => {
	const $ = c(6);
	let t0;
	let t1;
	if ($[0] !== panelId) {
		t0 = (listener) => panelHistory.subscribe(panelId, listener);
		t1 = () => panelHistory.getSnapshot(panelId);
		$[0] = panelId;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	const state = useSyncExternalStore(t0, t1, _temp);
	const t2 = state.back.length > 0;
	const t3 = state.forward.length > 0;
	let t4;
	if ($[3] !== t2 || $[4] !== t3) {
		t4 = {
			canBack: t2,
			canForward: t3
		};
		$[3] = t2;
		$[4] = t3;
		$[5] = t4;
	} else t4 = $[5];
	return t4;
};
function _temp() {
	return EMPTY;
}
//#endregion
export { PanelHistoryStore, goBackInPanel, goForwardInPanel, navigateInPanel, panelHistory, usePanelHistory, writePanelContent };

//# sourceMappingURL=panelHistory.js.map