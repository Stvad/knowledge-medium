import { ChangeScope } from "./api/changeScope.js";
import "./api/index.js";
import { aliasesProp, hasBlockType, selectionStateProp, showPropertiesProp, userIdProp } from "./properties.js";
import memoize from "../../node_modules/lodash-es/memoize.js";
import v5 from "../../node_modules/uuid/dist/v5.js";
import { PAGE_TYPE, USER_TYPE } from "./blockTypes.js";
import { USER_PREFS_PATH_PART } from "./userPrefs.js";
//#region src/data/stateBlocks.ts
/**
* User-local state plumbing — per-user "user page", synced user prefs,
* per-plugin sub-blocks, and per-panel ui-state child tree. Pure
* (non-React) helpers live here; React hooks that consume them live in
* `globalState.ts`. Splitting along this fault line keeps module-init
* import graphs out of `react`/`@/context/repo`, which is what lets
* `pluginStateExtensions.ts` import these helpers statically without
* cycling through `repoProvider → staticDataExtensions → plugin/*`.
*
* Deterministic ids derived from (workspace, user, ...) keep two
* offline clients converging on the same row when they later sync.
*/
var USER_PAGE_NS = "99b1b4e5-6f58-4fd2-9089-dc3b358dd4df";
var STATE_CHILD_NS = "8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2";
/** Deterministic id of a user's "user page" block. Exported so display
*  surfaces can resolve an arbitrary `userId` (e.g. a row's `updatedBy`)
*  back to its page — and thus its display name — without knowing the
*  namespace. Two offline clients derive the same id, so a user's page
*  authored on one device resolves the same on every other. */
var userPageBlockId = (workspaceId, userId) => v5(`${workspaceId}:${userId}`, USER_PAGE_NS);
var stateChildBlockId = (parentId, content) => v5(`${parentId}:${content}`, STATE_CHILD_NS);
var snapshotIncludingType = (repo, type) => {
	const snapshot = repo.snapshotTypeRegistries();
	if (snapshot.types.has(type.id)) return snapshot;
	const types = new Map(snapshot.types);
	types.set(type.id, type);
	const propertySchemas = new Map(snapshot.propertySchemas);
	for (const schema of type.properties ?? []) if (!propertySchemas.has(schema.name)) propertySchemas.set(schema.name, schema);
	return {
		types,
		propertySchemas
	};
};
var requireWorkspaceId = (repo, caller) => {
	const workspaceId = repo.activeWorkspaceId;
	if (!workspaceId) throw new Error(`${caller} requires an active workspace; call repo.setActiveWorkspaceId() first`);
	return workspaceId;
};
var requireSchemaScope = (schema, scope, caller) => {
	if (schema.changeScope !== scope) throw new Error(`${caller} expected ${scope} property ${schema.name}, got ${schema.changeScope}`);
	return schema;
};
/** Idempotent state child creation. Returns the Block facade for
*  the child whose content equals `content` under `parent`. The id
*  comes from `stateChildBlockId(parentId, content)` so repeat calls hit
*  the same row deterministically. Restores soft-deleted rows in the
*  same scope.
*
*  Cold-start fast path: if the child is already live in cache or in
*  SQL (the common case after the first launch), skip the
*  writeTransaction entirely. The bootstrap path through this helper
*  is called from at least four memoized parents (user-prefs,
*  ui-state, panels, plus per-plugin children); a no-op tx still
*  costs ~100 ms each because of trigger overhead, so amortizing
*  those across cold start has been a measurable cost. The slow
*  path is identical to before — `tx.get` re-checks under the lock
*  to handle the (rare) tombstone case that `repo.load` filters out
*  with its `deleted = 0` predicate. */
var ensureStateChild = async (repo, parent, namespace, scope, initialProperties = {}, displayContent = namespace, type) => {
	const parentData = parent.peek() ?? await parent.load();
	if (!parentData) throw new Error(`ensureStateChild: parent ${parent.id} not loaded`);
	const childId = stateChildBlockId(parent.id, namespace);
	const live = await repo.load(childId);
	if (live) {
		if (type && !hasBlockType(live, type.id)) {
			const typeSnapshot = snapshotIncludingType(repo, type);
			await repo.tx(async (tx) => {
				const current = await tx.get(childId);
				if (!current || current.deleted || hasBlockType(current, type.id)) return;
				await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot);
			}, {
				scope,
				description: `ensureStateChild ${namespace}`
			});
		}
		return repo.block(childId);
	}
	const typeSnapshot = type ? snapshotIncludingType(repo, type) : void 0;
	await repo.tx(async (tx) => {
		const existing = await tx.get(childId);
		if (existing && !existing.deleted) {
			if (type && !hasBlockType(existing, type.id)) await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot);
			return;
		}
		if (existing && existing.deleted) {
			await tx.restore(childId, { content: displayContent });
			if (type) await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot);
			return;
		}
		await tx.create({
			id: childId,
			workspaceId: parentData.workspaceId,
			parentId: parent.id,
			orderKey: "a0",
			content: displayContent,
			properties: initialProperties
		}, { systemMint: true });
		if (type) await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot);
	}, {
		scope,
		description: `ensureStateChild ${namespace}`
	});
	const child = repo.block(childId);
	await child.load();
	return child;
};
var ensureUiChild = (repo, parent, namespace, content) => ensureStateChild(repo, parent, namespace, ChangeScope.UiState, {}, content);
var ensureUserPrefsChild = (repo, parent) => ensureStateChild(repo, parent, USER_PREFS_PATH_PART, ChangeScope.UserPrefs, {}, "Preferences");
var dedupe = (values) => [...new Set(values)];
/** Repair an existing user page to the current shape: the user id as an
*  alias, the `USER_TYPE` marker, and the `user:id` property. Pages
*  created before any of these existed (or restored by an older client)
*  are upgraded in place on first access. Idempotent and additive —
*  never rewrites the display-name alias or content, so a user who
*  renamed their own page keeps that. Runs at most once per memoized
*  (repo, workspace, user) since the caller is itself memoized; the peek
*  skips the tx entirely once the page is up to date. Best-effort: an
*  alias-collision rejection (the id already claimed elsewhere — not
*  expected for opaque ids) is swallowed so it can't break user-page
*  resolution. */
var reconcileUserPage = async (repo, id, userId) => {
	const block = repo.block(id);
	const data = block.peek();
	if (!data) return;
	if ((block.peekProperty(aliasesProp) ?? []).includes(userId) && hasBlockType(data, "user") && (block.peekProperty(userIdProp) ?? "") === userId) return;
	const typeSnapshot = repo.snapshotTypeRegistries();
	try {
		await repo.tx(async (tx) => {
			const row = await tx.get(id);
			if (!row || row.deleted) return;
			const txAliases = await tx.getProperty(id, aliasesProp);
			if (!txAliases.includes(userId)) await tx.setProperty(id, aliasesProp, [...txAliases, userId]);
			if (await tx.getProperty(id, userIdProp) !== userId) await tx.setProperty(id, userIdProp, userId);
			await repo.addTypeInTx(tx, id, USER_TYPE, {}, typeSnapshot);
		}, {
			scope: ChangeScope.UserPrefs,
			description: "user-page reconcile"
		});
	} catch (err) {
		console.warn(`[stateBlocks] could not reconcile user page ${id}:`, err);
	}
};
/** Per-user "user page" block — created (or restored) on first access.
*  The aliases match the user's display name *and* opaque id so
*  alias-based lookup surfaces can target it either way. Memoized per
*  (repo, workspaceId, userId) — `use()` requires a stable promise per
*  render.
*
*  The fast path uses `repo.load` to skip the tx entirely when the row
*  is already live in cache or in SQL. Tombstone branch lives INSIDE
*  the tx because `repo.load` filters `deleted = 0` (so tombstones
*  always come back as `null`); we have to use `tx.get` to see them. */
var getUserBlock = memoize(async (repo, workspaceId, user) => {
	const id = userPageBlockId(workspaceId, user.id);
	if (await repo.load(id)) {
		await reconcileUserPage(repo, id, user.id);
		return repo.block(id);
	}
	const displayName = user.name ?? user.id;
	const aliases = dedupe([displayName, user.id]);
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const existing = await tx.get(id);
		if (existing && !existing.deleted) return;
		if (existing && existing.deleted) {
			await tx.restore(id, { content: displayName });
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: aliases }, typeSnapshot);
			await repo.addTypeInTx(tx, id, USER_TYPE, { [userIdProp.name]: user.id }, typeSnapshot);
			return;
		}
		await tx.create({
			id,
			workspaceId,
			parentId: null,
			orderKey: "a0",
			content: displayName
		}, { systemMint: true });
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: aliases }, typeSnapshot);
		await repo.addTypeInTx(tx, id, USER_TYPE, { [userIdProp.name]: user.id }, typeSnapshot);
	}, { scope: ChangeScope.UserPrefs });
	return repo.block(id);
}, (repo, workspaceId, user) => instanceKey(repo, workspaceId, user.id));
var getUserPrefsBlock = memoize(async (repo, workspaceId, user) => {
	return ensureUserPrefsChild(repo, await getUserBlock(repo, workspaceId, user));
}, (repo, workspaceId, user) => instanceKey(repo, workspaceId, user.id, "__user_prefs__"));
/** Per-plugin preferences sub-block under the root user-prefs block.
*  Each plugin gets its own child keyed by the type contribution's `id`,
*  carrying that id as its block type marker. Splitting preferences across
*  per-plugin rows (rather than packing them all into the root block's
*  `properties_json`) bounds the blast radius of any single PATCH upload
*  to one plugin's settings — the row-level UPDATE trigger writes the full
*  `properties_json` column on any property change, so unrelated plugins'
*  values are no longer at risk of being clobbered by a peer's edit. */
var getPluginPrefsBlock = memoize(async (repo, workspaceId, user, type) => {
	return ensureStateChild(repo, await getUserPrefsBlock(repo, workspaceId, user), type.id, ChangeScope.UserPrefs, { [showPropertiesProp.name]: showPropertiesProp.codec.encode(true) }, type.label ?? type.id, type);
}, (repo, workspaceId, user, type) => instanceKey(repo, workspaceId, user.id, "plugin-prefs", type.id));
/** Resolve the UI-state block scoped to the current panel context.
*  In a panel context (`context.panelId`), returns the panel's own
*  block — per-panel UI state lives directly on it. Outside a panel,
*  returns the user-level `ui-state` child of the user page. */
var getUIStateBlock = memoize(async (repo, workspaceId, user, context) => {
	if (context.panelId) {
		await repo.load(context.panelId);
		return repo.block(context.panelId);
	}
	return ensureUiChild(repo, await getUserBlock(repo, workspaceId, user), "ui-state");
}, (repo, workspaceId, user, context) => instanceKey(repo, workspaceId, user.id, context.panelId ?? "__root__"));
var LAYOUT_SESSIONS_PATH_PART = "layout-sessions";
var getLayoutSessionBlock = memoize(async (uiStateBlock, layoutSessionId) => {
	const layoutSessionsBlock = await ensureUiChild(uiStateBlock.repo, uiStateBlock, LAYOUT_SESSIONS_PATH_PART);
	return ensureUiChild(uiStateBlock.repo, layoutSessionsBlock, layoutSessionId);
}, (uiBlock, layoutSessionId) => instanceKey(uiBlock.repo, uiBlock.id, layoutSessionId));
/** Per-plugin ui-state sub-block under the root ui-state block. The
*  mirror of `getPluginPrefsBlock` for persistent UI state — e.g.
*  "what blocks did the user open recently". Writes flow through
*  `ChangeScope.UiState`: not undoable, but they upload and sync
*  across devices like any other write. */
var getPluginUIStateBlock = memoize(async (repo, workspaceId, user, type) => {
	return ensureStateChild(repo, await getUIStateBlock(repo, workspaceId, user, {}), type.id, ChangeScope.UiState, {}, type.label ?? type.id, type);
}, (repo, workspaceId, user, type) => instanceKey(repo, workspaceId, user.id, "plugin-ui-state", type.id));
/** A per-key child under a plugin's ui-state sub-block, so a plugin can
*  partition its ui-state (e.g. one frozen review session per deck)
*  instead of overloading a single block and discriminating by hand.
*  Inherits the parent's `ChangeScope.UiState` (undo-segregated from
*  document edits). Mirrors `getLayoutSessionBlock`. */
var getPluginUIStateChild = memoize(async (pluginUIStateBlock, key, content) => ensureUiChild(pluginUIStateBlock.repo, pluginUIStateBlock, key, content), (pluginUIStateBlock, key) => instanceKey(pluginUIStateBlock.repo, pluginUIStateBlock.id, key));
/** Sync selection-state read; doesn't subscribe — for use in
*  imperative shortcut handlers. Returns the schema default when
*  nothing's stored. */
var getSelectionStateSnapshot = (uiStateBlock) => uiStateBlock.peekProperty(selectionStateProp) ?? selectionStateProp.defaultValue;
var resetBlockSelection = async (uiStateBlock) => {
	const current = uiStateBlock.peekProperty(selectionStateProp);
	if (!current?.selectedBlockIds.length && !current?.anchorBlockId) return;
	await uiStateBlock.set(selectionStateProp, {
		selectedBlockIds: [],
		anchorBlockId: null
	});
};
/** Build a memo key scoped to a Repo instance: the repo's `instanceId`
*  followed by the caller's discriminating parts, ':'-joined. Every
*  cache below shares this convention (a stale/unscoped key would hand a
*  `use()` consumer a promise from a disposed repo), so single-sourcing
*  it here keeps a new cache from silently picking a colliding or
*  unscoped key. */
var instanceKey = (repo, ...parts) => [repo.instanceId, ...parts].join(":");
//#endregion
export { getLayoutSessionBlock, getPluginPrefsBlock, getPluginUIStateBlock, getPluginUIStateChild, getSelectionStateSnapshot, getUIStateBlock, getUserBlock, getUserPrefsBlock, requireSchemaScope, requireWorkspaceId, resetBlockSelection, userPageBlockId };

//# sourceMappingURL=stateBlocks.js.map