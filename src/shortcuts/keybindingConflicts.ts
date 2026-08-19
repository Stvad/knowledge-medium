/**
 * Conflict detection for the keybindings settings UI.
 *
 * Operates on the *effective* action list (after `applyKeybindingOverrides`
 * has run). The collision-strip rule means default-vs-override clashes
 * are already resolved by the time we get here — what remains are
 * user-vs-user (or override-vs-override) clashes where two actions
 * both kept their chord. Those are what the UI warns about.
 *
 *   Conflict := two distinct actions share a chord in overlapping
 *               contexts. "Overlapping" mirrors `applyKeybindingOverrides`:
 *               identical contexts, or at least one is `'global'`.
 */
import type {
  ActionConfig,
  ActionContextType,
} from '@/shortcuts/types.js'
import { canonicalizeChord, toChordArray } from './canonicalizeChord.ts'

export interface KeybindingConflict {
  readonly chord: string
  readonly actions: readonly ActionConflictParticipant[]
}

export interface ActionConflictParticipant {
  readonly actionId: string
  readonly context: ActionContextType
  readonly description: string
}

const contextsOverlap = (a: ActionContextType, b: ActionContextType): boolean =>
  a === b || a === 'global' || b === 'global'

const participantOf = (action: ActionConfig): ActionConflictParticipant => ({
  actionId: action.id,
  context: action.context,
  description: action.description,
})

/** All chord clashes across the supplied actions. Each returned entry
 *  groups every action that participates in that chord-context overlap.
 *  Stable order: chords sorted lexicographically, actions sorted by id. */
export const findKeybindingConflicts = (
  actions: readonly ActionConfig[],
): readonly KeybindingConflict[] => {
  // Bucket by the canonical key so alias-equivalent chords (`Cmd+K` and
  // `$mod+k`, or a reordered `Shift+$mod+k`) land together; keep the
  // first-seen raw chord as the bucket's reported form so the warning
  // shows the chord the user actually authored, not its canonical spelling.
  const byChord = new Map<string, {chord: string; actions: ActionConfig[]}>()
  for (const action of actions) {
    if (!action.defaultBinding) continue
    for (const chord of toChordArray(action.defaultBinding.keys)) {
      const key = canonicalizeChord(chord)
      const bucket = byChord.get(key) ?? {chord, actions: []}
      bucket.actions.push(action)
      byChord.set(key, bucket)
    }
  }

  const conflicts: KeybindingConflict[] = []
  for (const {chord, actions: candidates} of byChord.values()) {
    if (candidates.length < 2) continue
    const participants = findOverlappingGroup(candidates)
    if (participants.length < 2) continue
    conflicts.push({
      chord,
      actions: participants
        .map(participantOf)
        .toSorted((a, b) => a.actionId.localeCompare(b.actionId)),
    })
  }

  return conflicts.toSorted((a, b) => a.chord.localeCompare(b.chord))
}

/** From the candidates list, pick the largest subset whose contexts
 *  all pairwise-overlap. With the current rule (same OR global) this
 *  reduces to: include every candidate whose context is `global`, then
 *  include candidates from whichever non-global context has the
 *  highest count alongside them. Conservative — under-reports rather
 *  than over-reports when contexts are heterogeneous. */
const findOverlappingGroup = (candidates: readonly ActionConfig[]): readonly ActionConfig[] => {
  const globals = candidates.filter(a => a.context === 'global')
  const scoped = candidates.filter(a => a.context !== 'global')

  if (globals.length >= 2) {
    // All globals trivially overlap with each other and with every
    // scoped candidate — they form one big conflict.
    return [...globals, ...scoped]
  }

  if (globals.length === 1) {
    // The global participates with every scoped candidate, but the
    // scoped candidates only pairwise-overlap if they share a context.
    // Group scoped by context; the global joins the biggest bucket.
    const byContext = groupByContext(scoped)
    const biggest = pickBiggest(byContext)
    if (!biggest || biggest.length === 0) {
      // No scoped peers — the lone global doesn't conflict with anything.
      return []
    }
    return [...globals, ...biggest]
  }

  // No globals — biggest same-context bucket.
  const byContext = groupByContext(scoped)
  return pickBiggest(byContext) ?? []
}

const groupByContext = (actions: readonly ActionConfig[]): Map<ActionContextType, ActionConfig[]> => {
  const out = new Map<ActionContextType, ActionConfig[]>()
  for (const action of actions) {
    const bucket = out.get(action.context) ?? []
    bucket.push(action)
    out.set(action.context, bucket)
  }
  return out
}

const pickBiggest = <T>(buckets: Map<unknown, T[]>): T[] | undefined => {
  let best: T[] | undefined
  for (const bucket of buckets.values()) {
    if (!best || bucket.length > best.length) best = bucket
  }
  return best
}

// Re-exported for callers that want to test their own actions for overlap.
export { contextsOverlap }
