/**
 * The resolution core: pure, DOM-free functions that decide which
 * action(s) a trigger maps to, best-first. Shared by the keyboard
 * coordinator (`HotkeyReconciler`) and the imperative
 * `runActionById`/`useRunAction` paths so the two can never diverge on
 * precedence — that divergence is the bug this core retires.
 *
 * `resolve` ORDERS candidates; it does not MATCH chords. Keyboard chord
 * matching (including tinykeys sequence state for `g g`) stays in the
 * coordinator, which feeds `resolve` the candidates that have already
 * completed a match this event (a `'keyboard'` trigger). Reducing a keydown
 * to one descriptor and matching on it here is exactly how sequence chords
 * went dead historically, so resolve never sees the chord — only the
 * already-matched candidate set, which it filters (modal shadowing) and
 * orders.
 */
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type BaseShortcutDependencies,
  type Priority,
} from '@/shortcuts/types.js'
import type { ActiveContextsMap } from './ActiveContexts.tsx'

/**
 * What's being resolved. The kind selects the install-filter policy:
 *  - `'action'` — imperative lookup by id (runActionById / useRunAction).
 *    Modal shadowing is NOT applied; an action is found in any active context.
 *    The context MUST be active (deps come from the active map).
 *  - `'supplied'` — imperative lookup by id where the CALLER supplies the deps
 *    (swipe gesture / quick-action menu). Like `'action'` but the context need
 *    NOT be active — the supplied deps are the activation, validated in
 *    `resolveDeps`. Modal shadowing is not applied.
 *  - `'keyboard'` — the coordinator's already-matched candidate set for a
 *    chord. Modal shadowing IS applied (the keyboard gather filter).
 *  - `'pointer'` — pointer-bound candidates already matched on their binding
 *    descriptor and dispatched with supplied deps (see the filter note below).
 */
export type Trigger =
  | { kind: 'action'; actionId: string }
  | { kind: 'supplied'; actionId: string }
  | { kind: 'keyboard' }
  | { kind: 'pointer' }

/** Everything the comparator needs that isn't on the `ActionConfig`. */
export interface ResolutionContext {
  readonly active: ActiveContextsMap
  readonly contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>
}

/**
 * When any active context is `modal`, the contributing set collapses to
 * `{global, <most-recent-modal>}`; otherwise every active context
 * contributes. The `global` carve-out keeps app-wide chords (Cmd+K, …)
 * reachable while a modal is up. Most-recent-modal wins because
 * `ActiveContextsMap` is insertion-ordered with re-activations rotated to
 * the end (see ActiveContexts.tsx).
 *
 * This is the install/gather filter (which contexts contribute candidates
 * at all). Ordering the gathered candidates is `compareContexts`' job.
 */
export const computeInstallableContexts = (
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
): ReadonlySet<ActionContextType> => {
  const contexts = Array.from(active.keys())
  const latestModal = contexts.toReversed().find(type =>
    contextConfigsByType.get(type)?.modal === true,
  )
  if (!latestModal) return new Set(contexts)
  return new Set([ActionContextTypes.GLOBAL, latestModal])
}

const PRIORITY_RANK: Record<Priority, number> = {low: 0, default: 1, high: 2}

// Primary tier: an active `modal` outranks `global`, `global` outranks the
// rest. Ordered ascending so a larger number wins.
//
// `TIER_MODAL > TIER_GLOBAL` bakes in the modal-over-global default, which is
// still an OPEN ledger item ("global vs active modal on the same chord —
// needs explicit sign-off"; see docs/action-system-implementation-plan.html).
// It's currently moot — nothing binds a global chord that an active modal
// also claims (e.g. no global Escape) — but if that decision reverses, this
// is the one line to change, and it routes through the single comparator.
const TIER_SCOPED = 0
const TIER_GLOBAL = 1
const TIER_MODAL = 2

const tierOf = (type: ActionContextType, config: ActionContextConfig | undefined): number =>
  config?.modal === true ? TIER_MODAL
    : type === ActionContextTypes.GLOBAL ? TIER_GLOBAL
    : TIER_SCOPED

/**
 * Order two contexts best-first: modal-over-global, then priority desc,
 * then activation-recency desc. Returns a negative number when `a` should
 * rank before `b`. The single source of precedence — both the coordinator
 * and `getActiveActionById` route through it so dispatch and keyboard
 * paths can't disagree.
 */
export const compareContexts = (
  a: ActionContextType,
  b: ActionContextType,
  {active, contextConfigsByType}: ResolutionContext,
): number => {
  const order = Array.from(active.keys())
  const configA = contextConfigsByType.get(a)
  const configB = contextConfigsByType.get(b)
  return (
    tierOf(b, configB) - tierOf(a, configA) ||
    PRIORITY_RANK[configB?.priority ?? 'default'] - PRIORITY_RANK[configA?.priority ?? 'default'] ||
    order.indexOf(b) - order.indexOf(a)
  )
}

/**
 * Order the actions a trigger could fire, best-first.
 *
 * For `{kind:'action'}` the input is the full effective-action list and
 * `resolve` filters to the matching id. For a keyboard `ChordDescriptor`
 * the coordinator passes the candidates that already completed a match, so
 * the only filtering left is "is this context still active + installable".
 * Either way the result is ordered by `compareContexts`; the caller takes
 * the first (single-winner) or iterates (declinable fall-through, Phase 1
 * PR 2).
 */
export const resolve = (
  actions: readonly ActionConfig[],
  ctx: ResolutionContext,
  trigger: Trigger,
): readonly ActionConfig[] => {
  // Modal shadowing is a keyboard-install concern only: imperative
  // id-invocation (runActionById / useRunAction) finds an action in any
  // active context, matching the old getActiveActionById. So the installable
  // filter applies to keyboard triggers, not to `{kind:'action'}` or
  // `{kind:'pointer'}`.
  const installable =
    trigger.kind === 'keyboard'
      ? computeInstallableContexts(ctx.active, ctx.contextConfigsByType)
      : undefined
  const candidates = actions.filter(action => {
    switch (trigger.kind) {
      case 'action':
        // Imperative lookup: any active context, matching id.
        return ctx.active.has(action.context) && action.id === trigger.actionId
      case 'supplied':
        // Imperative by-id dispatch with caller-supplied deps. The context
        // need NOT be active — the caller (swipe gesture, quick-action menu)
        // holds the deps and the gesture itself is the activation. resolveDeps
        // validates the supplied deps at the dispatch boundary. Modal shadowing
        // is a keyboard-install concern and does not apply here.
        return action.id === trigger.actionId
      case 'keyboard':
        // Already-matched chord candidates, gated by modal shadowing.
        return ctx.active.has(action.context) && installable!.has(action.context)
      case 'pointer':
        // Candidates are pre-filtered by binding match and dispatched with
        // supplied deps, so the context need NOT be active — the click itself
        // provides the context. resolve only orders them. Modal shadowing is
        // deliberately NOT applied: a click on a block targets that block
        // regardless of which mode holds keyboard focus (shift-click selection
        // fired through a plain DOM onClick before this migration too, so this
        // preserves behavior). FIXME(phase3): this blanket bypass is only sound
        // for inherently spatially-targeted gestures. A future non-spatial
        // pointer action that SHOULD be suppressed under a modal overlay (e.g.
        // while the command palette is up) will need a per-action/context
        // opt-in to shadowing before it can rely on this arm.
        return true
    }
  })
  return [...candidates].sort((x, y) => compareContexts(x.context, y.context, ctx))
}

/**
 * Resolve the dependency object an action's handler receives: the active
 * context's deps merged with any caller-supplied deps, validated at this one
 * boundary — the single widened→narrow cast point. Returns `null` when the
 * context isn't active or the merged deps fail validation; in the run loop
 * that means "skip this candidate, try the next", never abort.
 *
 * Deliberately NOT an installability check: modal shadowing is the keyboard
 * gather filter (`computeInstallableContexts`), layered by the coordinator —
 * so imperative `runActionById` still resolves deps for an action in any
 * active context.
 *
 * `supplied` lets callers hand in deps the active map doesn't hold — a pointer
 * gesture supplying the CLICKED block's deps, or swipe's `runBlockAction`
 * supplying the swiped block's deps. When deps are supplied they STAND ALONE:
 * the gesture itself is the activation, so the supplied object is the complete
 * dependency set and the active context's deps are NOT merged underneath.
 *
 * Standalone (rather than `{...base, ...supplied}`) is deliberate and the safer
 * contract. A merge lets any field a caller OMITS silently inherit an unrelated
 * active instance's value — e.g. a focused embed's `renderScopeId` /
 * `scopeRootForcesOpen` leaking into a swipe action and making it focus/open as
 * if from that embed. No call site can defend against that without exhaustively
 * restating every field on every dispatch; making supplied deps standalone
 * retires the whole class at the boundary instead. This is a behaviour change
 * only when `action.context` is coincidentally active (the leak case): pointer
 * contexts are never activated, and swipe already supplies a complete set, so
 * both keep resolving the same deps they did before.
 *
 * Validation runs only when deps are supplied — active-map deps were already
 * validated at activation, so re-validating is redundant. A supplied set that's
 * incomplete now fails validation (→ null → skip) rather than borrowing missing
 * fields from an unrelated active instance, which is the more correct failure.
 */
export const resolveDeps = (
  action: ActionConfig,
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
  supplied?: Partial<BaseShortcutDependencies>,
): BaseShortcutDependencies | null => {
  if (!supplied) return active.get(action.context) ?? null
  const config = contextConfigsByType.get(action.context)
  if (config && !config.validateDependencies(supplied)) return null
  return supplied as BaseShortcutDependencies
}
