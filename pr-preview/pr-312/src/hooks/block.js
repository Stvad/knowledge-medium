import isEqual from "../../node_modules/lodash-es/isEqual.js";
import { useRepo } from "../context/repo.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/hooks/block.ts
/**
* React adapters over the data-layer surface (spec §5.1, §9.5).
*
* Phase 2.D: every hook below is a thin wrapper over `useHandle(...)`,
* which is the React→Handle bridge:
*
*   - `useHandle(handle)` — `useSyncExternalStore` over `handle.peek()`
*     + `handle.subscribe()`. Optional `{selector, eq}` for derived
*     selections with snapshot-identity memoization (so selectors that
*     allocate, e.g. `doc => doc.children.map(...)`, don't violate
*     React's "getSnapshot must return a stable reference" rule).
*
* Behavior contract per hook:
*   - useData / useContent / useProperty: row-grain reactivity via
*     Block (which implements Handle<BlockData|null>).
*   - useChildIds / useChildren / useHasChildren: collection reactivity
*     via `repo.children(id)`. The HandleStore + TxEngine fast path +
*     row_events tail (Phase 2.C) drive invalidation; the per-hook
*     `db.onChange({tables: ['blocks']})` polling that the old shape
*     used is gone.
*   - useParents: handle via `repo.ancestors(id)`.
*   - useSubtree: handle via `repo.subtree(id)` (new in Phase 2.D).
*
* The legacy `useDataWithSelector` is gone — selectors move to the
* `useHandle(handle, {selector})` option.
*/
var EMPTY_BLOCK_DATA_ARRAY = Object.freeze([]);
var areSelectedValuesEqual = (left, right) => {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	return isEqual(left, right);
};
var identitySelector = (v) => v;
function useHandle(handle, opts) {
	const selector = opts?.selector ?? identitySelector;
	const equality = opts?.eq ?? areSelectedValuesEqual;
	const committedRef = useRef({
		hasValue: false,
		value: void 0
	});
	const getSelection = useMemo(() => {
		let hasMemo = false;
		let memoizedSource;
		let memoizedSelection;
		return () => {
			const source = handle.peek();
			if (hasMemo && Object.is(source, memoizedSource)) return memoizedSelection;
			const next = selector(source);
			if (hasMemo && equality(memoizedSelection, next)) {
				memoizedSource = source;
				return memoizedSelection;
			}
			if (committedRef.current.hasValue && equality(committedRef.current.value, next)) {
				hasMemo = true;
				memoizedSource = source;
				memoizedSelection = committedRef.current.value;
				return memoizedSelection;
			}
			hasMemo = true;
			memoizedSource = source;
			memoizedSelection = next;
			return next;
		};
	}, [
		handle,
		selector,
		equality
	]);
	useEffect(() => {
		if (handle.status() === "idle") handle.load().catch(() => {});
	}, [handle]);
	const value = useSyncExternalStore(useCallback((listener) => handle.subscribe(listener), [handle]), getSelection, getSelection);
	useEffect(() => {
		committedRef.current = {
			hasValue: true,
			value
		};
	}, [value]);
	return value;
}
/** Reactive read of the block's BlockData snapshot. `undefined` until
*  the row is loaded or when confirmed-missing — callers that need the
*  loading-vs-missing distinction read `block.status()` / `block.peek()`
*  directly. */
var useData = (block) => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp };
		$[0] = t0;
	} else t0 = $[0];
	return useHandle(block, t0);
};
/** Reactive content read. `''` when not loaded. */
var useContent = (block) => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp2 };
		$[0] = t0;
	} else t0 = $[0];
	return useHandle(block, t0);
};
/** Reactive existence read. `false` while loading and for confirmed-missing rows. */
var useBlockExists = (block) => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp3 };
		$[0] = t0;
	} else t0 = $[0];
	return useHandle(block, t0);
};
/** Reactive workspace id read. Falls back while loading or confirmed missing. */
var useWorkspaceId = (block, t0) => {
	const $ = c(2);
	const fallback = t0 === void 0 ? "" : t0;
	let t1;
	if ($[0] !== fallback) {
		t1 = { selector: (doc) => doc?.workspaceId ?? fallback };
		$[0] = fallback;
		$[1] = t1;
	} else t1 = $[1];
	return useHandle(block, t1);
};
/** Reactive content plus updatedAt revision, for editors that need stale-write guards. */
var useContentRevision = (block) => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp4 };
		$[0] = t0;
	} else t0 = $[0];
	return useHandle(block, t0);
};
/** Reactive update metadata for freshness indicators. */
var useUpdateMetadata = (block) => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp5 };
		$[0] = t0;
	} else t0 = $[0];
	return useHandle(block, t0);
};
/** Reactive typed property read + setter. The setter opens its own tx
*  via `repo.mutate.setProperty` (whose scope derives from
*  `schema.changeScope` — the scope identity drives undo bucketing and
*  schema validation; the actual upload routing is uniform across
*  scopes). Returns `[value, setValue]` where value falls back to
*  `schema.defaultValue` when the property isn't present. */
function useProperty(block, schema) {
	const $ = c(8);
	let t0;
	if ($[0] !== schema) {
		t0 = { selector: (doc) => {
			if (!doc) return schema.defaultValue;
			const stored = doc.properties[schema.name];
			if (stored === void 0) return schema.defaultValue;
			return schema.codec.decode(stored);
		} };
		$[0] = schema;
		$[1] = t0;
	} else t0 = $[1];
	const value = useHandle(block, t0);
	let t1;
	if ($[2] !== block || $[3] !== schema) {
		t1 = (next) => {
			block.set(schema, next);
		};
		$[2] = block;
		$[3] = schema;
		$[4] = t1;
	} else t1 = $[4];
	const setValue = t1;
	let t2;
	if ($[5] !== setValue || $[6] !== value) {
		t2 = [value, setValue];
		$[5] = setValue;
		$[6] = value;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
}
/** Alias kept for migration parity with the legacy hook name. */
var usePropertyValue = useProperty;
var EMPTY_STRING_ARRAY = Object.freeze([]);
/** Reactive child-id list (in `(orderKey, id)` order). Returns `[]`
*  while the handle is loading or for a leaf block.
*
*  Backed by `repo.childIds(id)` rather than `repo.children(id)` —
*  declares only a `parent-edge` dep, so unrelated child mutations
*  (focus moves on a UI-state child, content edits, etc.) don't
*  invalidate the handle at all. The list-shape consumers
*  (`BlockChildren`, `LayoutRenderer`'s panel iteration) are the hot
*  path that motivated the split.
*
*  Opts into `{hydrate: true}` so the loader runs the full
*  CHILDREN_SQL and hydrates each child row into the cache. Without
*  this, every LazyBlockComponent that mounts on intersection would
*  pay its own `block.load()` round-trip and the page would visibly
*  pop in block-by-block. The lean variant on `repo.childIds` is for
*  non-rendering callers (counting / id-only scans). */
var useChildIds = (block) => {
	const $ = c(4);
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t0 = block.repo.query.childIds({
			id: block.id,
			hydrate: true
		});
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp6 };
		$[3] = t1;
	} else t1 = $[3];
	return useHandle(t0, t1);
};
/** Reactive child Block facades. Same structural-equality bail-out
*  story as `useChildIds` — `repo.block(id)` is identity-stable, so the
*  Block[] returned compares equal across re-fires when the id list is
*  unchanged, and `useHandle` hands back the previously-committed
*  reference. Critical for callers like `LayoutRenderer` whose JSX
*  builds context-provider overrides per panel; without ref stability
*  here, every UI-state child mutation would propagate a fresh context
*  value to the entire block subtree. */
var useChildren = (block) => {
	const $ = c(5);
	const repo = block.repo;
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t0 = block.repo.query.children({ id: block.id });
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] !== repo) {
		t1 = { selector: (data) => (data ?? EMPTY_BLOCK_DATA_ARRAY).map((d) => repo.block(d.id)) };
		$[3] = repo;
		$[4] = t1;
	} else t1 = $[4];
	return useHandle(t0, t1);
};
/** Whether the block has children. Backed by `repo.childIds` so child
*  content edits don't even invalidate the handle (vs. the prior
*  `repo.children`-backed shape, which fired on every descendant row
*  change and only bailed at the React boundary via the boolean
*  selector).
*
*  Shares `useChildIds`'s hydrating handle slot (`{hydrate: true}`)
*  rather than spinning up a separate lean handle for the same parent
*  — every block that renders a bullet (BlockBullet) also renders its
*  children (BlockChildren), so the two hooks subscribe to the same
*  parent in lockstep and there's nothing to gain by splitting them. */
var useHasChildren = (block) => {
	const $ = c(4);
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t0 = block.repo.query.childIds({
			id: block.id,
			hydrate: true
		});
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp7 };
		$[3] = t1;
	} else t1 = $[3];
	return useHandle(t0, t1);
};
/** Reactive parent chain (root → … → immediate parent), excluding
*  `block` itself. `repo.ancestors()` walks leaf-to-root, so reverse
*  for the breadcrumb-friendly order callers expect. */
var useParents = (block) => {
	const $ = c(5);
	const repo = block.repo;
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t0 = block.repo.query.ancestors({ id: block.id });
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] !== repo) {
		t1 = { selector: (data) => (data ?? EMPTY_BLOCK_DATA_ARRAY).map((d) => repo.block(d.id)).reverse() };
		$[3] = repo;
		$[4] = t1;
	} else t1 = $[4];
	return useHandle(t0, t1);
};
var EMPTY_PARENT_MAP = /* @__PURE__ */ new Map();
/** Batched variant of `useParents` — runs one `core.manyAncestors`
*  query for every id in `blocks`. Returns a Map<id, Block[]> in the
*  same root→…→immediate-parent order each per-id `useParents` would
*  produce.
*
*  Use over N `useParents` calls when a parent component knows the
*  full id set up front (backlinks panel, tag list, etc.). One SQL
*  round-trip vs. N: on a contended SQLite connection during cold
*  start, the win is meaningful (a 15-entry backlinks panel went
*  from ~2.3 s of summed ancestor wall time to ~150 ms in
*  measurements).
*
*  Stability: the query handle is keyed by the sorted id list, so
*  re-renders with the same blocks (stable identity) hit the same
*  cached handle. Block facade identity is stable per id, so the
*  returned arrays compare equal across re-fires when the chain is
*  unchanged. Empty entries land for ids whose row is missing. */
var useManyParents = (blocks) => {
	const $ = c(7);
	const repo = useRepo();
	let t0;
	if ($[0] !== blocks) {
		t0 = Array.from(new Set(blocks.map(_temp8))).sort();
		$[0] = blocks;
		$[1] = t0;
	} else t0 = $[1];
	const ids = t0;
	let t1;
	if ($[2] !== ids || $[3] !== repo.query) {
		t1 = repo.query.manyAncestors({ ids });
		$[2] = ids;
		$[3] = repo.query;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== repo) {
		t2 = { selector: (data) => {
			if (!data || data.length === 0) return EMPTY_PARENT_MAP;
			const out = /* @__PURE__ */ new Map();
			for (const entry of data) {
				const parents = entry.ancestors.map((d) => repo.block(d.id)).reverse();
				out.set(entry.startId, parents);
			}
			return out;
		} };
		$[5] = repo;
		$[6] = t2;
	} else t2 = $[6];
	return useHandle(t1, t2);
};
/** Reactive subtree (root + descendants), in SUBTREE_SQL order. New in
*  Phase 2.D for parity with the four `repo.X` factories; existing
*  call sites can adopt incrementally. */
var useSubtree = (block) => {
	const $ = c(5);
	const repo = block.repo;
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t0 = block.repo.query.subtree({ id: block.id });
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] !== repo) {
		t1 = { selector: (data) => (data ?? EMPTY_BLOCK_DATA_ARRAY).map((d) => repo.block(d.id)) };
		$[3] = repo;
		$[4] = t1;
	} else t1 = $[4];
	return useHandle(t0, t1);
};
/** Reactive typed block query. `workspaceId` is required on the
*  passed query — pass `repo.activeWorkspaceId` explicitly when you
*  really do want the user's currently-active workspace. Requiring the
*  field at the type level prevents background flows / import surfaces
*  from silently mis-scoping when the user switches workspaces mid-flight
*  (PR #47 review). */
var useBlockQuery = (query) => {
	const $ = c(4);
	const repo = useRepo();
	let t0;
	if ($[0] !== query || $[1] !== repo.query) {
		t0 = repo.query.typedBlocks(query);
		$[0] = query;
		$[1] = repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp9 };
		$[3] = t1;
	} else t1 = $[3];
	return useHandle(t0, t1);
};
function _temp(doc) {
	return doc ?? void 0;
}
function _temp2(doc) {
	return doc?.content ?? "";
}
function _temp3(doc) {
	return Boolean(doc);
}
function _temp4(doc) {
	return doc ? {
		content: doc.content,
		updatedAt: doc.updatedAt
	} : void 0;
}
function _temp5(doc) {
	return doc ? {
		updatedAt: doc.updatedAt,
		userUpdatedAt: doc.userUpdatedAt,
		updatedBy: doc.updatedBy
	} : void 0;
}
function _temp6(ids) {
	return ids ?? EMPTY_STRING_ARRAY;
}
function _temp7(ids) {
	return (ids ?? EMPTY_STRING_ARRAY).length > 0;
}
function _temp8(b) {
	return b.id;
}
function _temp9(data) {
	return data ?? EMPTY_BLOCK_DATA_ARRAY;
}
//#endregion
export { useBlockExists, useBlockQuery, useChildIds, useChildren, useContent, useContentRevision, useData, useHandle, useHasChildren, useManyParents, useParents, useProperty, usePropertyValue, useSubtree, useUpdateMetadata, useWorkspaceId };

//# sourceMappingURL=block.js.map