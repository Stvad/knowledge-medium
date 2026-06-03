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
 * completed a match this event. The `ChordDescriptor` trigger is read as
 * "the chord that just completed" — carried for dedup/logging, never used
 * to match here. Reducing a keydown to one descriptor and matching on it
 * is exactly how sequence chords went dead historically.
 */
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type Priority,
} from '@/shortcuts/types.js'
import type { ActiveContextsMap } from './ActiveContexts.tsx'
import type { ChordDescriptor } from './canonicalizeChord.ts'

export type Trigger =
  | { kind: 'action'; actionId: string }
  | ChordDescriptor // keyboard now; mouse/touch descriptors in Phase 3

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
  const installable = computeInstallableContexts(ctx.active, ctx.contextConfigsByType)
  const candidates = actions.filter(action => {
    if (!ctx.active.has(action.context)) return false
    if (!installable.has(action.context)) return false
    if (trigger.kind === 'action' && action.id !== trigger.actionId) return false
    return true
  })
  return [...candidates].sort((x, y) => compareContexts(x.context, y.context, ctx))
}
