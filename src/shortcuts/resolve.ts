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
 *  - `'keyboard'` — the coordinator's already-matched candidate set for a
 *    chord. Modal shadowing IS applied (the keyboard gather filter).
 * Phase 3 will extend the keyboard arm with a normalized pointer/touch
 * descriptor when a caller actually constructs one (see `ChordDescriptor`,
 * whose `kind` field stays open for that); resolve doesn't need the chord
 * itself, only the policy + the candidate set.
 */
export type Trigger =
  | { kind: 'action'; actionId: string }
  | { kind: 'keyboard' }

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
  // filter applies to keyboard triggers, not to `{kind:'action'}`.
  const installable =
    trigger.kind === 'action'
      ? undefined
      : computeInstallableContexts(ctx.active, ctx.contextConfigsByType)
  const candidates = actions.filter(action => {
    if (!ctx.active.has(action.context)) return false
    return trigger.kind === 'action'
      ? action.id === trigger.actionId
      : installable!.has(action.context)
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
 * `supplied` is plumbed for callers that hold deps the active map doesn't yet
 * (Phase 3's swipe `runBlockAction` passing `{block, uiStateBlock}` instead of
 * forking the dispatcher); it's unused for now. Validation runs only when deps
 * are supplied — active-map deps were already validated at activation, so
 * re-validating them would be redundant work.
 */
export const resolveDeps = (
  action: ActionConfig,
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
  supplied?: Partial<BaseShortcutDependencies>,
): BaseShortcutDependencies | null => {
  const base = active.get(action.context)
  if (!base) return null
  if (!supplied) return base
  const merged = {...base, ...supplied}
  const config = contextConfigsByType.get(action.context)
  if (config && !config.validateDependencies(merged)) return null
  return merged
}
