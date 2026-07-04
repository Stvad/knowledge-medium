import { ChangeScope } from "./api/changeScope.js";
import { isSystemAuthor } from "./api/user.js";
import "./api/index.js";
import { activePanelIdProp, focusedBlockLocationFromProperties, isEditingProp, selectionStateProp } from "./properties.js";
import { useUser } from "../components/Login.js";
import { USER_PREFS_PATH_PART } from "./userPrefs.js";
import { getLayoutSessionBlock, getPluginPrefsBlock, getPluginUIStateBlock, getPluginUIStateChild, getUIStateBlock, getUserBlock, requireSchemaScope, requireWorkspaceId, userPageBlockId } from "./stateBlocks.js";
import { useRepo } from "../context/repo.js";
import { useChildren, useHandle, usePropertyValue } from "../hooks/block.js";
import { useBlockContext } from "../context/block.js";
import { useActiveWorkspaceId } from "../hooks/useWorkspaces.js";
import { getLayoutSessionId } from "../utils/layoutSessionId.js";
import { use } from "react";
import { c } from "react/compiler-runtime";
//#region src/data/globalState.ts
/**
* React hooks for the per-user "user page", synced user prefs,
* per-plugin sub-blocks, and per-panel ui-state child tree. The
* non-React resolvers / mutators live in `stateBlocks.ts`; this file
* is the React-aware façade over them.
*
* Transient app-shell and plugin UI state (focus, selection, edit-mode,
* top-level block, etc.) uses `ChangeScope.UiState`; user preferences
* use `ChangeScope.UserPrefs` and live on their own child rows so
* unrelated properties never share a row-level UPDATE payload. Both
* scopes upload through the normal queue — the scope identity is what
* drives undo bucketing and schema validation, not the upload routing.
*/
function useUIStateBlock() {
	const $ = c(5);
	const context = useBlockContext();
	const repo = useRepo();
	const user = useUser();
	let t0;
	let t1;
	if ($[0] !== context || $[1] !== repo || $[2] !== user) {
		const workspaceId = requireWorkspaceId(repo, "useUIStateBlock");
		t0 = use;
		t1 = getUIStateBlock(repo, workspaceId, user, context);
		$[0] = context;
		$[1] = repo;
		$[2] = user;
		$[3] = t0;
		$[4] = t1;
	} else {
		t0 = $[3];
		t1 = $[4];
	}
	return t0(t1);
}
/** Root app-shell UI state, independent of the current panel context. */
function useRootUIStateBlock() {
	const $ = c(4);
	const repo = useRepo();
	const user = useUser();
	let t0;
	let t1;
	if ($[0] !== repo || $[1] !== user) {
		const workspaceId = requireWorkspaceId(repo, "useRootUIStateBlock");
		t0 = use;
		t1 = getUIStateBlock(repo, workspaceId, user, {});
		$[0] = repo;
		$[1] = user;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	return t0(t1);
}
function useLayoutSessionBlock(t0) {
	const $ = c(5);
	let t1;
	if ($[0] !== t0) {
		t1 = t0 === void 0 ? getLayoutSessionId() : t0;
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const layoutSessionId = t1;
	const t2 = useRootUIStateBlock();
	let t3;
	if ($[2] !== layoutSessionId || $[3] !== t2) {
		t3 = getLayoutSessionBlock(t2, layoutSessionId);
		$[2] = layoutSessionId;
		$[3] = t2;
		$[4] = t3;
	} else t3 = $[4];
	return use(t3);
}
function usePanelsForLayoutSession(t0) {
	const $ = c(2);
	let t1;
	if ($[0] !== t0) {
		t1 = t0 === void 0 ? getLayoutSessionId() : t0;
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	return useChildren(useLayoutSessionBlock(t1));
}
function useUserBlock() {
	const $ = c(4);
	const repo = useRepo();
	const user = useUser();
	const workspaceId = useActiveWorkspaceId();
	if (!workspaceId) throw new Error("useUserBlock requires an active workspace");
	let t0;
	if ($[0] !== repo || $[1] !== user || $[2] !== workspaceId) {
		t0 = getUserBlock(repo, workspaceId, user);
		$[0] = repo;
		$[1] = user;
		$[2] = workspaceId;
		$[3] = t0;
	} else t0 = $[3];
	return use(t0);
}
/** Resolve a `userId` (as stored in `created_by` / `updated_by`) to its
*  user page: the display name plus — only when the page block actually
*  exists in this workspace — its block id, so callers can link to it.
*
*  Reads the user-page block's content (which the page's owning client
*  keeps in sync with their name) via its deterministic id, so it works
*  for any user whose page has synced here, not just the current one.
*  While the page is loading or absent (e.g. a peer who hasn't synced
*  yet) `name` falls back to the raw id and `blockId` is omitted — so
*  attribution degrades to the prior plain-text behaviour rather than
*  rendering a link to a block that doesn't exist. */
function useUserPage(userId) {
	const $ = c(8);
	const repo = useRepo();
	let id;
	let t0;
	if ($[0] !== repo || $[1] !== userId) {
		id = userPageBlockId(requireWorkspaceId(repo, "useUserPage"), userId);
		t0 = repo.block(id);
		$[0] = repo;
		$[1] = userId;
		$[2] = id;
		$[3] = t0;
	} else {
		id = $[2];
		t0 = $[3];
	}
	const block = t0;
	let t1;
	if ($[4] !== id || $[5] !== userId) {
		t1 = { selector: (doc) => doc ? {
			name: doc.content || userId,
			blockId: id
		} : { name: userId } };
		$[4] = id;
		$[5] = userId;
		$[6] = t1;
	} else t1 = $[6];
	const resolved = useHandle(block, t1);
	if (isSystemAuthor(userId)) {
		let t2;
		if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
			t2 = { name: "System" };
			$[7] = t2;
		} else t2 = $[7];
		return t2;
	}
	return resolved;
}
/** Hook to access and modify a UI-state property on the active UI-state
*  block. The property's schema dictates codec + default; writes are
*  scoped via the schema's `changeScope` (typically `UiState`). */
function useUIStateProperty(schema) {
	const $ = c(2);
	const block = useUIStateBlock();
	let t0;
	if ($[0] !== schema) {
		t0 = requireSchemaScope(schema, ChangeScope.UiState, "useUIStateProperty");
		$[0] = schema;
		$[1] = t0;
	} else t0 = $[1];
	return usePropertyValue(block, t0);
}
function useRootUIStateProperty(schema) {
	const $ = c(2);
	const block = useRootUIStateBlock();
	let t0;
	if ($[0] !== schema) {
		t0 = requireSchemaScope(schema, ChangeScope.UiState, "useRootUIStateProperty");
		$[0] = schema;
		$[1] = t0;
	} else t0 = $[1];
	return usePropertyValue(block, t0);
}
/** Resolve the per-plugin user-prefs sub-block for a given type
*  contribution. The block is bootstrapped on first access via
*  `getPluginPrefsBlock`; subsequent calls return the same Block facade. */
function usePluginPrefsBlock(type) {
	const $ = c(5);
	const repo = useRepo();
	const user = useUser();
	let t0;
	let t1;
	if ($[0] !== repo || $[1] !== type || $[2] !== user) {
		const workspaceId = requireWorkspaceId(repo, "usePluginPrefsBlock");
		t0 = use;
		t1 = getPluginPrefsBlock(repo, workspaceId, user, type);
		$[0] = repo;
		$[1] = type;
		$[2] = user;
		$[3] = t0;
		$[4] = t1;
	} else {
		t0 = $[3];
		t1 = $[4];
	}
	return t0(t1);
}
/** Read/write a user-pref property on the plugin's own sub-block. The
*  schema must declare `changeScope: ChangeScope.UserPrefs` so reads and
*  writes route through the synced (and read-only-aware) pref pipeline. */
var usePluginPrefsProperty = (type, schema) => {
	const $ = c(2);
	const t0 = usePluginPrefsBlock(type);
	let t1;
	if ($[0] !== schema) {
		t1 = requireSchemaScope(schema, ChangeScope.UserPrefs, "usePluginPrefsProperty");
		$[0] = schema;
		$[1] = t1;
	} else t1 = $[1];
	return usePropertyValue(t0, t1);
};
/** Resolve the per-plugin ui-state sub-block for a given type
*  contribution. The mirror of `usePluginPrefsBlock` for persistent
*  ui-state — the block lives under the root ui-state subtree. Like all
*  `ChangeScope.UiState` writes it is non-undoable but still uploads and
*  syncs through the normal queue, so the state is restored across
*  devices (a deliberate uniform-substrate decision). */
function usePluginUIStateBlock(type) {
	const $ = c(5);
	const repo = useRepo();
	const user = useUser();
	let t0;
	let t1;
	if ($[0] !== repo || $[1] !== type || $[2] !== user) {
		const workspaceId = requireWorkspaceId(repo, "usePluginUIStateBlock");
		t0 = use;
		t1 = getPluginUIStateBlock(repo, workspaceId, user, type);
		$[0] = repo;
		$[1] = type;
		$[2] = user;
		$[3] = t0;
		$[4] = t1;
	} else {
		t0 = $[3];
		t1 = $[4];
	}
	return t0(t1);
}
/** Resolve a per-`key` child of the plugin's ui-state sub-block, for
*  plugins that partition their ui-state (e.g. one frozen review session
*  per deck, keyed by deck id) instead of overloading a single block. The
*  child is bootstrapped on first access. */
function usePluginUIStateChildBlock(type, key) {
	const $ = c(3);
	const t0 = usePluginUIStateBlock(type);
	let t1;
	if ($[0] !== key || $[1] !== t0) {
		t1 = getPluginUIStateChild(t0, key);
		$[0] = key;
		$[1] = t0;
		$[2] = t1;
	} else t1 = $[2];
	return use(t1);
}
/** Read/write a ui-state property on the plugin's own ui-state
*  sub-block. The schema must declare `changeScope: ChangeScope.UiState`
*  so writes route into the ui-state subtree (and stay undo-segregated
*  from document edits). They still upload and sync through the normal
*  queue. */
var usePluginUIStateProperty = (type, schema) => {
	const $ = c(2);
	const t0 = usePluginUIStateBlock(type);
	let t1;
	if ($[0] !== schema) {
		t1 = requireSchemaScope(schema, ChangeScope.UiState, "usePluginUIStateProperty");
		$[0] = schema;
		$[1] = t1;
	} else t1 = $[1];
	return usePropertyValue(t0, t1);
};
/** Sugar for the global editing flag — `[isEditing, setIsEditing]`. */
var useIsEditing = () => {
	return useUIStateProperty(isEditingProp);
};
/** Selection state — sticky on the UI-state block. The setter merges
*  partial updates into the current snapshot. */
function useSelectionState() {
	const $ = c(6);
	const [current, setRaw] = usePropertyValue(useUIStateBlock(), selectionStateProp);
	let t0;
	if ($[0] !== current || $[1] !== setRaw) {
		t0 = (newState) => {
			setRaw({
				...current,
				...newState
			});
		};
		$[0] = current;
		$[1] = setRaw;
		$[2] = t0;
	} else t0 = $[2];
	const setSelectionState = t0;
	let t1;
	if ($[3] !== current || $[4] !== setSelectionState) {
		t1 = [current, setSelectionState];
		$[3] = current;
		$[4] = setSelectionState;
		$[5] = t1;
	} else t1 = $[5];
	return t1;
}
var useInFocus = (blockId, explicitRenderScopeId) => {
	const $ = c(3);
	const context = useBlockContext();
	const renderScopeId = explicitRenderScopeId ?? (typeof context.renderScopeId === "string" ? context.renderScopeId : void 0);
	let t0;
	if ($[0] !== blockId || $[1] !== renderScopeId) {
		t0 = { selector: (doc) => {
			const location = focusedBlockLocationFromProperties(doc?.properties);
			if (!location || location.blockId !== blockId) return false;
			return renderScopeId ? location.renderScopeId === renderScopeId : true;
		} };
		$[0] = blockId;
		$[1] = renderScopeId;
		$[2] = t0;
	} else t0 = $[2];
	return useHandle(useUIStateBlock(), t0);
};
var useIsSelected = (blockId) => {
	const $ = c(2);
	let t0;
	if ($[0] !== blockId) {
		t0 = { selector: (doc) => {
			const stored = doc?.properties[selectionStateProp.name];
			if (stored === void 0) return false;
			return selectionStateProp.codec.decode(stored).selectedBlockIds.includes(blockId);
		} };
		$[0] = blockId;
		$[1] = t0;
	} else t0 = $[1];
	return useHandle(useUIStateBlock(), t0);
};
var useInEditMode = (blockId, explicitRenderScopeId) => {
	const $ = c(3);
	const context = useBlockContext();
	const renderScopeId = explicitRenderScopeId ?? (typeof context.renderScopeId === "string" ? context.renderScopeId : void 0);
	let t0;
	if ($[0] !== blockId || $[1] !== renderScopeId) {
		t0 = { selector: (doc) => {
			const location = focusedBlockLocationFromProperties(doc?.properties);
			if (!location || location.blockId !== blockId) return false;
			if (renderScopeId && location.renderScopeId !== renderScopeId) return false;
			return Boolean(doc?.properties[isEditingProp.name]);
		} };
		$[0] = blockId;
		$[1] = renderScopeId;
		$[2] = t0;
	} else t0 = $[2];
	return useHandle(useUIStateBlock(), t0);
};
/**
* Whether `panelBlock` is the currently-active panel in its layout
* session. Per-panel boolean (same selector pattern as `useInFocus`):
* when activePanelId hops between panels, only the two whose membership
* flips re-render — the rest bail via `useSyncExternalStore`'s Object.is.
*
* When the panel renders OUTSIDE a layout session (no
* `layoutSessionBlockId` in context — e.g. a standalone embedded or
* preview surface) the concept of "active panel" doesn't apply, so we
* return `true`. Consumers that gate UI on "this surface owns
* keystrokes" treat non-layout surfaces as trivially active.
*/
var useIsActivePanel = (panelBlock) => {
	const $ = c(7);
	const context = useBlockContext();
	const repo = useRepo();
	const layoutSessionBlockId = typeof context.layoutSessionBlockId === "string" ? context.layoutSessionBlockId : null;
	let t0;
	if ($[0] !== layoutSessionBlockId || $[1] !== panelBlock || $[2] !== repo) {
		t0 = layoutSessionBlockId ? repo.block(layoutSessionBlockId) : panelBlock;
		$[0] = layoutSessionBlockId;
		$[1] = panelBlock;
		$[2] = repo;
		$[3] = t0;
	} else t0 = $[3];
	const subscriptionTarget = t0;
	let t1;
	if ($[4] !== layoutSessionBlockId || $[5] !== panelBlock) {
		t1 = { selector: (doc) => layoutSessionBlockId === null || doc?.properties[activePanelIdProp.name] === panelBlock.id };
		$[4] = layoutSessionBlockId;
		$[5] = panelBlock;
		$[6] = t1;
	} else t1 = $[6];
	return useHandle(subscriptionTarget, t1);
};
//#endregion
export { USER_PREFS_PATH_PART, useInEditMode, useInFocus, useIsActivePanel, useIsEditing, useIsSelected, useLayoutSessionBlock, usePanelsForLayoutSession, usePluginPrefsBlock, usePluginPrefsProperty, usePluginUIStateBlock, usePluginUIStateChildBlock, usePluginUIStateProperty, useRootUIStateBlock, useRootUIStateProperty, useSelectionState, useUIStateBlock, useUIStateProperty, useUserBlock, useUserPage };

//# sourceMappingURL=globalState.js.map