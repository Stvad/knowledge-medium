import { activePanelIdProp, topLevelBlockIdProp } from "../data/properties.js";
import { getLayoutSessionBlock, getUIStateBlock } from "../data/stateBlocks.js";
import { useRepo } from "../context/repo.js";
import { useBlockContext } from "../context/block.js";
import { getLayoutSessionId } from "./layoutSessionId.js";
import { defineVerbFacet } from "../facets/verbFacet.js";
import { navigateInPanel } from "./panelHistory.js";
import { insertPanelRow, insertSidebarStackedPanel, panelRowsInLayoutOrder } from "./panelLayoutProjection.js";
import { c } from "react/compiler-runtime";
//#region src/utils/navigation.ts
var resolveLayoutSessionBlock = async (repo, workspaceId) => {
	return getLayoutSessionBlock(await getUIStateBlock(repo, workspaceId, repo.user, {}), getLayoutSessionId());
};
var isMobileViewport = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
var setActivePanel = async (layoutSessionBlock, panelId) => {
	await layoutSessionBlock.load();
	if (layoutSessionBlock.peekProperty(activePanelIdProp) === panelId) return;
	await layoutSessionBlock.set(activePanelIdProp, panelId);
};
var panelRowsForLayoutSession = async (layoutSessionBlock) => panelRowsInLayoutOrder(layoutSessionBlock.id, await layoutSessionBlock.repo.query.subtree({ id: layoutSessionBlock.id }).load());
var resolveActivePanelRow = async (layoutSessionBlock) => {
	await layoutSessionBlock.load();
	const panelRows = await panelRowsForLayoutSession(layoutSessionBlock);
	const activePanelId = layoutSessionBlock.peekProperty(activePanelIdProp);
	return panelRows.find((row) => row.id === activePanelId) ?? panelRows.at(-1) ?? null;
};
var resolveDestination = async (repo, input) => {
	const { workspaceId } = input;
	switch (input.target) {
		case "new-panel": return {
			kind: "create-row",
			workspaceId,
			afterPanelId: input.sourcePanelId
		};
		case "sidebar-stack": return {
			kind: "create-stack",
			workspaceId,
			sourcePanelId: input.sourcePanelId
		};
		case "panel": return await repo.exists(input.panelId) ? {
			kind: "panel",
			workspaceId,
			panelId: input.panelId
		} : null;
		case "main": {
			const panels = await panelRowsForLayoutSession(await resolveLayoutSessionBlock(repo, workspaceId));
			return panels[0] ? {
				kind: "panel",
				workspaceId,
				panelId: panels[0].id
			} : {
				kind: "create-row",
				workspaceId
			};
		}
		case "active": {
			const panel = await resolveActivePanelRow(await resolveLayoutSessionBlock(repo, workspaceId));
			return panel ? {
				kind: "panel",
				workspaceId,
				panelId: panel.id
			} : {
				kind: "create-row",
				workspaceId
			};
		}
	}
};
/** Apply a resolved navigation by mutating layout-session panel rows, returning
*  where it landed. `navigationVerb`'s default impl. The "where does this go"
*  decision is `resolveDestination` (shared with the read path); this is just
*  the effect. The workspace comes from the resolved input — never a fresh
*  `repo.activeWorkspaceId` read — so an async observer/decorator can't move the
*  landing. Active-panel bookkeeping is awaited (so it can't outlive the
*  navigation and clobber a later one) but failure-isolated and after the swap,
*  so a layout-session failure can't swallow the already-applied content swap. */
var applyNavigation = async ({ repo, input }) => {
	const dest = await resolveDestination(repo, input);
	if (!dest) return null;
	const { workspaceId } = dest;
	const { blockId } = input;
	switch (dest.kind) {
		case "panel":
			await navigateInPanel(repo.block(dest.panelId), blockId);
			try {
				await setActivePanel(await resolveLayoutSessionBlock(repo, workspaceId), dest.panelId);
			} catch (error) {
				console.error("[navigation] Failed to mark panel active after navigation", error);
			}
			return {
				panelId: dest.panelId,
				blockId,
				workspaceId
			};
		case "create-row": return {
			panelId: await insertPanelRow(repo, await resolveLayoutSessionBlock(repo, workspaceId), blockId, { afterPanelId: dest.afterPanelId }),
			blockId,
			workspaceId
		};
		case "create-stack": return {
			panelId: await insertSidebarStackedPanel(repo, await resolveLayoutSessionBlock(repo, workspaceId), blockId, { sourcePanelId: dest.sourcePanelId }),
			blockId,
			workspaceId
		};
	}
};
/**
* The navigation EXECUTION seam. Plugins contribute:
*   - `navigationVerb.before/after` — observe navigations (history, analytics);
*     `after` gets the request + a `VerbOutcome<NavigationResult | null>`
*     (`{ok: true, result}` on success, `{ok: false, error}` on failure — it
*     fires for every outcome). (An observer must not unconditionally call
*     `navigate()` itself — it would re-enter the verb and loop.)
*   - `navigationVerb.impl` — replace navigation wholesale (`req => myNav(req)`).
*   - `navigationVerb.decorator` — wrap it: rewrite the intent (call `next` with
*     a changed `input` — e.g. redirect by `input.origin` / `input.target` /
*     the target block's type) or veto it (return `null` without calling
*     `next`). Rewrite by **spreading** the input (`{...req.input, …}`) — the
*     resolved `input.workspaceId` is required and must be carried; a decorator
*     that builds a fresh input and drops it fails closed (the result fails
*     `validateResult` → the navigation no-ops) rather than silently landing in
*     the wrong workspace. The type enforces this for typed plugins.
* With no contributions, `run` returns `applyNavigation(request)`, so
* `navigate()` behaves exactly as before the seam existed. Effectful verb on the
* default `onError: 'rethrow'`: a throwing override fails that one navigation
* (logged by `navigate`), never double-applies.
*/
var navigationVerb = defineVerbFacet({
	id: "core.navigate",
	defaultImpl: applyNavigation,
	validateResult: (result) => {
		if (result === null) return true;
		const r = result;
		return typeof r.panelId === "string" && typeof r.blockId === "string" && typeof r.workspaceId === "string";
	}
});
/** Go to a block / open it in a panel, returning where it landed (or `null` if
*  vetoed, no workspace, or it failed). Runs the (already-resolved) intent
*  through `navigationVerb`, then the default impl applies it. **Never rejects**
*  — errors are logged and become `null` — so the many fire-and-forget callers
*  can ignore the returned promise safely. The verb runs when a workspace
*  resolves and a facet runtime is installed (always in production); the
*  early-boot / minimal-harness path applies the default directly. */
var navigate = async (repo, input) => {
	const workspaceId = input.workspaceId ?? repo.activeWorkspaceId;
	if (!workspaceId) return null;
	const request = {
		repo,
		input: {
			...input,
			workspaceId
		}
	};
	const runtime = repo.facetRuntime;
	try {
		return runtime ? await navigationVerb.run(runtime, request) : await applyNavigation(request);
	} catch (error) {
		console.error("[navigation] navigate failed", error);
		return null;
	}
};
var useNavigate = () => {
	const $ = c(2);
	const repo = useRepo();
	let t0;
	if ($[0] !== repo) {
		t0 = (input) => navigate(repo, input);
		$[0] = repo;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
var blockLinkClickIntent = (event) => {
	if (event.shiftKey && event.altKey && !event.metaKey && !event.ctrlKey && event.button === 0) return "new-panel";
	if (event.shiftKey && !event.metaKey && !event.ctrlKey && event.button === 0) return "sidebar-stack";
	if (event.altKey && !event.metaKey && !event.ctrlKey && event.button === 0) return "main";
	if (event.metaKey || event.ctrlKey || event.button !== 0) return "native";
	return "default";
};
var PLAIN_PRIMARY_CLICK = {
	shiftKey: false,
	altKey: false,
	metaKey: false,
	ctrlKey: false,
	button: 0
};
var modifiersFromMouseEvent = (e) => ({
	shiftKey: e.shiftKey,
	altKey: e.altKey,
	metaKey: e.metaKey,
	ctrlKey: e.ctrlKey,
	button: e.button
});
var currentViewport = () => isMobileViewport() ? "mobile" : "desktop";
/** Build a `navigate` decision. */
var goTo = (input) => ({
	kind: "navigate",
	input
});
/** Decline the event — let the browser handle the native default (href).
*  Frozen: it's a shared public-API singleton; a consumer must not mutate it. */
var PASSTHROUGH = Object.freeze({ kind: "passthrough" });
/** Own the event and no-op (veto). Frozen — shared public-API singleton. */
var SUPPRESS = Object.freeze({ kind: "suppress" });
/** Transform only the `navigate` case of a decision, passing `passthrough` /
*  `suppress` through untouched — the ergonomic way for a plugin decorator to
*  tweak the resolved `NavigateInput`. `f` returning an explicit `null` is a
*  veto (→ `SUPPRESS`); ONLY `null`. Any other non-input result (e.g. an untyped
*  mapper with a missing `return` → `undefined`) is left as an invalid
*  `navigate` so the verb's `validateResult`/`onError` fall back to the default
*  policy — rather than silently turning a buggy mapper into a veto. */
var mapNavigate = (decision, f) => {
	if (decision.kind !== "navigate") return decision;
	const next = f(decision.input);
	return next === null ? SUPPRESS : goTo(next);
};
/** The default navigation policy: pure, synchronous, reproducing the canonical
*  modifier matrix + follow-link/navigator role + viewport rule. Returns a
*  `navigate` decision (whose input carries `origin: role` so execution-layer
*  decorators can tell follow-link clicks from navigator commands), or
*  `PASSTHROUGH` for a native gesture (cmd / ctrl / middle-click → let the
*  browser handle the href). Composable: a plugin policy can call this and
*  `mapNavigate` the result. */
var defaultNavigationIntent = (gesture) => {
	const { role, modifiers, panelId, blockId, workspaceId, viewport } = gesture;
	const base = {
		blockId,
		workspaceId,
		origin: role
	};
	switch (blockLinkClickIntent(modifiers)) {
		case "native": return PASSTHROUGH;
		case "new-panel": return goTo({
			...base,
			target: "new-panel",
			sourcePanelId: panelId
		});
		case "sidebar-stack": return goTo({
			...base,
			target: "sidebar-stack",
			sourcePanelId: panelId
		});
		case "main": return goTo({
			...base,
			target: "main"
		});
		case "default":
			if (role === "navigator") return goTo({
				...base,
				target: viewport === "mobile" ? "active" : "main"
			});
			return goTo(panelId ? {
				...base,
				target: "panel",
				panelId
			} : {
				...base,
				target: "active"
			});
	}
};
var isOptionalString = (value) => value === void 0 || typeof value === "string";
var isNavigateInput = (value) => {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	if (typeof v.blockId !== "string") return false;
	if (!isOptionalString(v.workspaceId) || !isOptionalString(v.origin)) return false;
	switch (v.target) {
		case "main":
		case "active": return true;
		case "new-panel":
		case "sidebar-stack": return isOptionalString(v.sourcePanelId);
		case "panel": return typeof v.panelId === "string";
		default: return false;
	}
};
var isNavigationDecision = (value) => {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	switch (v.kind) {
		case "passthrough":
		case "suppress": return true;
		case "navigate": return isNavigateInput(v.input);
		default: return false;
	}
};
/**
* The navigation INTENT seam (policy). Plugins contribute to remap the
* gesture→target mapping, returning a `NavigationDecision`:
*   - `navigationIntentVerb.impl` — replace resolution wholesale.
*   - `navigationIntentVerb.decorator` — wrap it: remap the modifier matrix,
*     override the follow-link/navigator role, redirect where global commands
*     land (active vs main), or flip a gesture between in-app navigation and
*     native passthrough — call `next(gesture)` and reshape via `mapNavigate`
*     (tweak the input) or by returning `PASSTHROUGH` / `SUPPRESS` / `goTo(…)`.
*   - `navigationIntentVerb.before/after` — observe gestures.
* Pure verb on `onError: 'fallback'`: a throwing/invalid plugin policy falls
* back to `defaultNavigationIntent`, so one buggy policy can't break navigation.
* Resolved with `runSync` (the policy is pure, no I/O) so gesture surfaces can
* gate `preventDefault` on the result — so contributions must be **synchronous**;
* an `impl`/`decorator` that returns a promise violates the contract and falls
* back to `defaultNavigationIntent` (async before/after observers are fine —
* they're fire-and-forget). The resolved `NavigationDecision` is routed by the
* surface (`applyNavigationDecision` for clicks) or, for navigate, by `navigate()`.
*/
var navigationIntentVerb = defineVerbFacet({
	id: "core.navigation-intent",
	defaultImpl: defaultNavigationIntent,
	onError: "fallback",
	validateResult: isNavigationDecision
});
/** Resolve a gesture into a `NavigationDecision` through the intent policy,
*  **synchronously** — so a gesture surface can gate `preventDefault` on the
*  result before yielding. **Never throws**: `runSync` already falls back to
*  `defaultNavigationIntent` for a buggy plugin policy (`onError: 'fallback'`);
*  the try/catch here guards the verb machinery itself. The early-boot /
*  minimal-harness path (no runtime) applies the default policy directly.
*
*  Carries the gesture's captured workspace into a `navigate` decision that
*  omitted one (a plugin policy may), so it lands in the workspace the gesture
*  originated in — even if a policy mutated the active workspace synchronously
*  during resolution. Centralized here so every consumer (clicks + commands)
*  inherits it; a policy that sets `workspaceId` wins. */
var resolveNavigationIntent = (repo, gesture) => {
	const runtime = repo.facetRuntime;
	let decision;
	if (!runtime) decision = defaultNavigationIntent(gesture);
	else try {
		decision = navigationIntentVerb.runSync(runtime, gesture);
	} catch (error) {
		console.error("[navigation] intent resolution failed", error);
		decision = defaultNavigationIntent(gesture);
	}
	return decision.kind === "navigate" && !decision.input.workspaceId ? goTo({
		...decision.input,
		workspaceId: gesture.workspaceId
	}) : decision;
};
/** Apply a resolved decision to the click that produced it — the single place
*  that maps an intent outcome onto DOM event handling, so no clickable surface
*  re-implements the native-vs-veto distinction:
*    - `passthrough` → decline the event; the browser follows the href.
*    - `navigate` / `suppress` → own the event (`stopPropagation` +
*      `preventDefault`); `navigate` then fires the in-app navigation,
*      `suppress` is a veto no-op. */
var applyNavigationDecision = (repo, e, decision) => {
	if (decision.kind === "passthrough") return;
	e.stopPropagation();
	e.preventDefault();
	if (decision.kind === "navigate") navigate(repo, decision.input);
};
/** Resolve a gesture through the intent policy, then execute it. The single
*  path from "user/command gesture" to a navigation; returns where it landed
*  (or `null` if the policy produced a no-op / the navigation was vetoed).
*  **Never rejects** — resolution falls back to the default policy (see
*  `resolveNavigationIntent`) and execution inherits `navigate`'s
*  catch-and-log — so the fire-and-forget click handlers are safe. */
var navigateFromGesture = async (repo, gesture) => {
	const decision = resolveNavigationIntent(repo, gesture);
	return decision.kind === "navigate" ? navigate(repo, decision.input) : null;
};
/** Navigate from a global command (command palette, shortcut, navigator-role
*  click that resolved its block): a plain navigator gesture, so the default
*  policy lands it in the main panel on desktop / the active panel on mobile.
*  Routed through the intent policy, so a plugin redirects where global
*  commands land by decorating `navigationIntentVerb` for `role: 'navigator'`.
*  origin defaults to `'navigator'`. */
var navigateFromGlobalCommand = (repo, { blockId, workspaceId }) => {
	const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId;
	if (!resolvedWorkspaceId) return Promise.resolve(null);
	return navigateFromGesture(repo, {
		role: "navigator",
		modifiers: PLAIN_PRIMARY_CLICK,
		blockId,
		workspaceId: resolvedWorkspaceId,
		viewport: currentViewport()
	});
};
var useNavigateFromGlobalCommand = () => {
	const $ = c(2);
	const repo = useRepo();
	let t0;
	if ($[0] !== repo) {
		t0 = (input) => navigateFromGlobalCommand(repo, input);
		$[0] = repo;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
/** The probe gesture the *read* path uses to ask the intent policy "which panel
*  does a navigator command target right now?" — the navigator target is
*  block-independent in the default policy (and any sane override), so the
*  blockId is a neutral placeholder; only the resolved `target` is read.
*  Expressing a query as a fake gesture is a known smell — tracked in #242 for a
*  first-class block-free "navigator target" query if a block-dependent
*  navigator policy ever becomes a real use case. */
var NAVIGATOR_TARGET_PROBE_BLOCK_ID = "";
/** Where a navigator global command currently anchors: the block shown in the
*  panel it targets, AND the workspace that panel lives in. The anchor for
*  read-then-navigate flows (e.g. daily-notes prev/next day). Routed through the
*  SAME policy + `resolveDestination` as the write, so the anchor and the
*  eventual navigation agree even when a policy retargets the panel (active vs
*  main) or the workspace — and it returns the resolved `workspaceId` so callers
*  validate/create against the workspace the block actually lives in, not the
*  one they passed in. `null` when there's no existing panel to anchor on (the
*  target would create a fresh panel) or no workspace. */
var resolveGlobalCommandTarget = async (repo, workspaceId = repo.activeWorkspaceId) => {
	if (!workspaceId) return null;
	const decision = resolveNavigationIntent(repo, {
		role: "navigator",
		modifiers: PLAIN_PRIMARY_CLICK,
		blockId: NAVIGATOR_TARGET_PROBE_BLOCK_ID,
		workspaceId,
		viewport: currentViewport()
	});
	if (decision.kind !== "navigate") return null;
	const dest = await resolveDestination(repo, {
		...decision.input,
		workspaceId: decision.input.workspaceId ?? workspaceId
	});
	if (dest?.kind !== "panel") return null;
	await repo.load(dest.panelId);
	const blockId = repo.block(dest.panelId).peekProperty(topLevelBlockIdProp);
	return typeof blockId === "string" ? {
		blockId,
		workspaceId: dest.workspaceId
	} : null;
};
/** The standard way for plugins and components to wire a clickable surface
*  that opens a block — links, buttons, map pins, calendar cells, anything.
*  Returns a modifier-aware onClick handler that resolves the gesture through
*  `navigationIntentVerb` (so the policy is plugin-customizable) and executes
*  the result.
*
*  For dynamic surfaces where the target block isn't known until the click
*  fires (e.g. breadcrumb chains, search result lists), use
*  `useBlockOpener` instead and pass the block at call time. */
var useOpenBlock = (t0, t1) => {
	const $ = c(8);
	const { blockId, workspaceId } = t0;
	let t2;
	if ($[0] !== t1) {
		t2 = t1 === void 0 ? {} : t1;
		$[0] = t1;
		$[1] = t2;
	} else t2 = $[1];
	const { plainClick: t3 } = t2;
	const plainClick = t3 === void 0 ? "follow-link" : t3;
	let t4;
	if ($[2] !== plainClick) {
		t4 = { plainClick };
		$[2] = plainClick;
		$[3] = t4;
	} else t4 = $[3];
	const opener = useBlockOpener(t4);
	let t5;
	if ($[4] !== blockId || $[5] !== opener || $[6] !== workspaceId) {
		t5 = (e) => opener(e, {
			blockId,
			workspaceId
		});
		$[4] = blockId;
		$[5] = opener;
		$[6] = workspaceId;
		$[7] = t5;
	} else t5 = $[7];
	return t5;
};
/** The opener-click logic behind `useBlockOpener`/`useOpenBlock`, factored out
*  of the hook so it's exercisable without a React render: build the gesture
*  from the event, resolve the full plugin-customized decision SYNCHRONOUSLY,
*  then let the single applier route it — `passthrough` lets the browser handle
*  the href (cmd-click new tab, …); `navigate`/`suppress` means we own the click.
*  Because the native-vs-veto distinction is the policy's `NavigationDecision`
*  (not a hardcoded pre-check), native passthrough is plugin-overridable: a
*  policy can turn a cmd-click into an in-app navigation, or a plain click into
*  a passthrough. No-ops when no workspace can be resolved. */
var openBlockFromEvent = (repo, e, { blockId, workspaceId }, { plainClick = "follow-link", panelId } = {}) => {
	const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId;
	if (!resolvedWorkspaceId) return;
	applyNavigationDecision(repo, e, resolveNavigationIntent(repo, {
		role: plainClick,
		modifiers: modifiersFromMouseEvent(e),
		panelId,
		blockId,
		workspaceId: resolvedWorkspaceId,
		viewport: currentViewport()
	}));
};
/** Returns an opener `(event, {blockId, workspaceId?}) => void` for places
*  that resolve the target block from the event (lists, breadcrumbs, map
*  markers rendered in a loop). Single subscription per component instead
*  of one hook per item. */
var useBlockOpener = (t0) => {
	const $ = c(6);
	let t1;
	if ($[0] !== t0) {
		t1 = t0 === void 0 ? {} : t0;
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	const { plainClick: t2 } = t1;
	const plainClick = t2 === void 0 ? "follow-link" : t2;
	const repo = useRepo();
	const { panelId } = useBlockContext();
	let t3;
	if ($[2] !== panelId || $[3] !== plainClick || $[4] !== repo) {
		t3 = (e, target) => openBlockFromEvent(repo, e, target, {
			plainClick,
			panelId
		});
		$[2] = panelId;
		$[3] = plainClick;
		$[4] = repo;
		$[5] = t3;
	} else t3 = $[5];
	return t3;
};
//#endregion
export { PASSTHROUGH, SUPPRESS, applyNavigationDecision, blockLinkClickIntent, defaultNavigationIntent, goTo, mapNavigate, navigate, navigateFromGesture, navigateFromGlobalCommand, navigationIntentVerb, navigationVerb, openBlockFromEvent, resolveGlobalCommandTarget, useBlockOpener, useNavigate, useNavigateFromGlobalCommand, useOpenBlock };

//# sourceMappingURL=navigation.js.map