/**
 * Pure pass that rewrites each action's `defaultBinding` from a list of
 * `KeybindingOverride` contributions. Invoked by `getEffectiveActions`
 * after the per-action transform pipeline.
 *
 * Rules:
 *
 *   1. **Direct override.** For each action, the last matching entry in
 *      `overrides` wins (the runtime feeds them in ascending precedence,
 *      so a user-prefs entry at precedence 100 trumps a plugin entry at
 *      precedence 0). A `keys` binding replaces `defaultBinding.keys`
 *      — installed NORMALISED (`normalizeChordSequence`), never
 *      verbatim: the collision-strip index (rule 2) buckets claims
 *      canonically, so installing the author's raw spelling would let a
 *      dispatch-dead spelling (`ctrl+x` — tinykeys knows `Control`, not
 *      `ctrl`) strip a live `Control+x` default while itself never
 *      firing (issue #388). Normalising folds modifier aliases to the
 *      names tinykeys dispatches while keeping the key's display case;
 *      claim and install can't disagree because canonicalizeChord of the
 *      normalised form equals canonicalizeChord of the raw form. User
 *      prefs keep the author's spelling — only the effective binding
 *      changes. An `unbound: true` binding clears `defaultBinding`.
 *
 *   2. **Default loses to override on chord collision.** When some
 *      override claims chord ⌘K for action B, any *other* action A
 *      whose default binding includes ⌘K — in an overlapping context —
 *      loses that chord. (A's default is filtered; A keeps any other
 *      chords it had.) Two overrides claiming the same chord both
 *      survive — that's the "warn + both fire" case the settings UI
 *      surfaces.
 *
 *   3. **Context overlap.** Two contexts overlap iff they're identical
 *      OR at least one is `'global'`. We can't enumerate the full
 *      activation graph (plugins register arbitrary contexts), so we
 *      pick the conservative rule: same context strips, global strips
 *      across the board, everything else is treated as disjoint.
 */
import type {
  ActionConfig,
  ActionContextType,
  KeyCombination,
} from '@/shortcuts/types.js'
import {
  isKeyOverrideUnbound,
  type KeybindingOverride,
  type KeyOverrideBound,
} from './keybindingOverrides.ts'
import { canonicalizeChord, normalizeChordSequence, toChordArray } from './canonicalizeChord.ts'

const fromChordArray = (chords: readonly string[]): KeyCombination | readonly KeyCombination[] =>
  chords.length === 1 ? chords[0]! : chords

const contextsOverlap = (a: ActionContextType, b: ActionContextType): boolean =>
  a === b || a === 'global' || b === 'global'

const matchesAction = (
  override: KeybindingOverride,
  action: Pick<ActionConfig, 'id' | 'context'>,
): boolean =>
  override.actionId === action.id &&
  (override.context === undefined || override.context === action.context)

/** Resolve an override's effective context: explicit `context` wins,
 *  otherwise fall back to the target action's own context (looked up
 *  by id in the supplied map). Returns null if neither is available —
 *  e.g. an override targeting an id no action declares. */
const effectiveContextFor = (
  override: KeybindingOverride,
  actionsById: ReadonlyMap<string, ActionContextType>,
): ActionContextType | null => {
  if (override.context !== undefined) return override.context
  const fallback = actionsById.get(override.actionId)
  return fallback ?? null
}

export const applyKeybindingOverrides = (
  actions: readonly ActionConfig[],
  overrides: readonly KeybindingOverride[],
): readonly ActionConfig[] => {
  if (overrides.length === 0) return actions

  // Per-action-id context fallback. Multiple actions can share an id
  // across contexts (the runtime keys by `${context}:${id}`); for the
  // fallback we only need *some* context per id — overrides that
  // genuinely need to disambiguate must pin `context` themselves.
  const actionContextById = new Map<string, ActionContextType>()
  for (const action of actions) {
    if (!actionContextById.has(action.id)) {
      actionContextById.set(action.id, action.context)
    }
  }

  // Index of "chord → effective contexts claimed by some override."
  // Used for the collision-strip pass over default bindings. Keyed by
  // the CANONICAL chord — the same notion of "the same chord"
  // keybindingConflicts.ts buckets by — so an override spelled
  // `Cmd+K` still strips a default spelled `$mod+k` (raw-string keys
  // left alias-equivalent spellings both live; found by
  // keybindingOverrides.fuzz.test.ts).
  const claimedByChord = new Map<string, Set<ActionContextType>>()
  for (const override of overrides) {
    if (isKeyOverrideUnbound(override.binding)) continue
    const ctx = effectiveContextFor(override, actionContextById)
    if (ctx === null) continue
    for (const chord of toChordArray((override.binding as KeyOverrideBound).keys)) {
      const key = canonicalizeChord(chord)
      let set = claimedByChord.get(key)
      if (!set) {
        set = new Set()
        claimedByChord.set(key, set)
      }
      set.add(ctx)
    }
  }

  return actions.map(action => applyToAction(
    action,
    overrides,
    claimedByChord,
  ))
}

const applyToAction = (
  action: ActionConfig,
  overrides: readonly KeybindingOverride[],
  claimedByChord: ReadonlyMap<string, ReadonlySet<ActionContextType>>,
): ActionConfig => {
  // 1. Direct override — last matching entry wins (callers sort by
  //    precedence ascending before passing the array in).
  let direct: KeybindingOverride | undefined
  for (const override of overrides) {
    if (matchesAction(override, action)) direct = override
  }

  if (direct) {
    if (isKeyOverrideUnbound(direct.binding)) {
      return {...action, defaultBinding: undefined}
    }
    return {
      ...action,
      defaultBinding: {
        ...(action.defaultBinding ?? {}),
        keys: fromChordArray(
          toChordArray(direct.binding.keys).map(chord => normalizeChordSequence(chord)),
        ) as KeyCombination | KeyCombination[],
      },
    }
  }

  // 2. No direct override — strip any default chord that another
  //    action's override has claimed in an overlapping context.
  if (!action.defaultBinding) return action

  const defaultChords = toChordArray(action.defaultBinding.keys)
  const survivors = defaultChords.filter(chord => {
    const claimingContexts = claimedByChord.get(canonicalizeChord(chord))
    if (!claimingContexts) return true
    for (const otherCtx of claimingContexts) {
      if (contextsOverlap(otherCtx, action.context)) return false
    }
    return true
  })

  if (survivors.length === defaultChords.length) return action
  if (survivors.length === 0) return {...action, defaultBinding: undefined}
  return {
    ...action,
    defaultBinding: {
      ...action.defaultBinding,
      keys: fromChordArray(survivors) as KeyCombination | KeyCombination[],
    },
  }
}
