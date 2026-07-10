/**
 * Pure model for the shortcut-help overlay (the Doom-style `?` popup).
 *
 * `buildShortcutHelpModel` flattens the effective action list into
 * per-active-context groups of keyboard bindings, ordered by the SAME
 * precedence core the dispatcher uses (`compareContexts`), with modal
 * shadowing marked via `computeInstallableContexts`. The overlay is a
 * truthful mirror of what a keypress would actually do, not a separate
 * hand-maintained cheat sheet. It is DOM-free so it unit-tests without a
 * browser. Chords are parsed with tinykeys' OWN `parseKeybinding` so the
 * per-press count (sequence arity, hold-sequence rejection) agrees with how
 * the dispatcher parses them; canonical chord strings are display-only.
 *
 * The live press-to-inspect matching itself lives in `useKeyInspector`, which
 * runs each binding through the shared `createSequenceMatcher` — the same
 * per-binding matcher the dispatcher installs — so the popup's verdict is the
 * verdict dispatch would reach.
 *
 * Deliberate approximations, documented rather than simulated: dispatch-time
 * gates that need live deps (`canDispatch`, deps resolution, a handler's
 * sync-`false` decline) and per-context `eventFilter`s are ignored — the
 * popup answers "what is this chord bound to", not "would it no-op right
 * now". The inspector also holds a sequence prefix indefinitely while the
 * real dispatcher times sequences out after ~1s: the popup exists to let
 * you READ the continuations, so it deliberately does not race you.
 */
import { toChordArray, type ChordPhase } from '@/shortcuts/canonicalizeChord.js'
import {
  parseKeybinding,
  type KeybindingPress,
} from 'tinykeys'
import { actionRuntimeKey } from '@/shortcuts/effectiveActions.js'
import {
  compareContexts,
  computeInstallableContexts,
  type ResolutionContext,
} from '@/shortcuts/resolve.js'
import type {
  ActionConfig,
  ActionContextConfig,
} from '@/shortcuts/types.js'
import { actionsFacet } from '@/extensions/core.js'
import type { FacetRuntime } from '@/facets/facet.js'

export interface HelpBinding {
  readonly action: ActionConfig
  readonly contextConfig: ActionContextConfig
  /** One chord as authored on the binding ('$mod+k', 'g g'). An action
   *  whose binding lists several keys yields one HelpBinding per chord. */
  readonly chord: string
  /** tinykeys-parsed presses — length > 1 for sequence chords. */
  readonly presses: readonly KeybindingPress[]
  readonly phase: ChordPhase
  /** Hold threshold, present exactly when `phase === 'hold'`. */
  readonly holdMs?: number
  /** True when modal shadowing keeps this binding uninstalled right now
   *  (its context is active but not installable). */
  readonly shadowed: boolean
  /** Plugin id that contributed the action (facet contribution `source`);
   *  undefined for contributions registered without one (built-ins). */
  readonly source?: string
}

export interface HelpContextGroup {
  readonly config: ActionContextConfig
  readonly shadowed: boolean
  /** Display name of the modal context doing the shadowing, when `shadowed`. */
  readonly shadowedBy?: string
  readonly bindings: readonly HelpBinding[]
}

export interface ShortcutHelpModel {
  /** Active contexts best-first (same order the dispatcher would consult). */
  readonly groups: readonly HelpContextGroup[]
  /** All groups' bindings flattened in group order. */
  readonly bindings: readonly HelpBinding[]
}

export const buildShortcutHelpModel = (
  actions: readonly ActionConfig[],
  ctx: ResolutionContext,
  sourceByActionKey?: ReadonlyMap<string, string>,
): ShortcutHelpModel => {
  const {active, contextConfigsByType} = ctx
  const installable = computeInstallableContexts(active, contextConfigsByType)
  const shadower = Array.from(installable)
    .map(type => contextConfigsByType.get(type))
    .find(config => config?.modal === true)

  const orderedTypes = Array.from(active.keys())
    .sort((a, b) => compareContexts(a, b, ctx))

  const groups: HelpContextGroup[] = []
  for (const type of orderedTypes) {
    const config = contextConfigsByType.get(type)
    // Unregistered contexts can't be activated (activate throws), and
    // keyboard-unbindable ones (block-pointer) carry no chords to list.
    if (!config || config.keyboardBindable === false) continue
    const shadowed = !installable.has(type)

    const bindings = actions
      .filter(action => action.context === type && action.defaultBinding)
      .flatMap(action => {
        const binding = action.defaultBinding!
        const phase: ChordPhase = binding.phase ?? 'keydown'
        const source = sourceByActionKey?.get(actionRuntimeKey(action))
        return toChordArray(binding.keys).flatMap((chord): HelpBinding[] => {
          const presses = parseKeybinding(chord)
          // Mirror installHoldBinding: a hold binding with a sequence chord
          // is rejected at install time, so don't list it as live.
          if (phase === 'hold' && presses.length > 1) return []
          return [{
            action,
            contextConfig: config,
            chord,
            presses,
            phase,
            ...(binding.phase === 'hold' ? {holdMs: binding.holdMs} : {}),
            shadowed,
            ...(source ? {source} : {}),
          }]
        })
      })

    groups.push({
      config,
      shadowed,
      ...(shadowed && shadower ? {shadowedBy: shadower.displayName} : {}),
      bindings,
    })
  }

  return {groups, bindings: groups.flatMap(g => g.bindings)}
}

/** `actionRuntimeKey` → contributing plugin id, from the raw `actionsFacet`
 *  contributions. Effective actions are rewritten copies (transform +
 *  override passes), so attribution matches on the context-qualified id,
 *  not object identity. Known limits: last write wins if two plugins
 *  contribute the same context:id, and a transform that REWRITES an
 *  action's id/context loses attribution (no in-tree transform does). */
export const actionSourcesFromRuntime = (runtime: FacetRuntime): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const contribution of runtime.contributionsById(actionsFacet.id)) {
    if (!contribution.source) continue
    out.set(actionRuntimeKey(contribution.value as ActionConfig), contribution.source)
  }
  return out
}

export interface HandlerDetails {
  readonly name?: string
  readonly source: string
}

/** Best-effort runtime description of the function a binding dispatches:
 *  the effective handler's name (when it has a meaningful one) and its
 *  source text. Readable in dev; reflects the minified bundle in prod —
 *  still enough to recognise which code a chord lands in. */
export const describeHandler = (action: ActionConfig): HandlerDetails => {
  const handler = action.handler as {name?: string; toString(): string}
  // Object-literal methods are all inferred as 'handler' — no signal there.
  const name = handler.name && handler.name !== 'handler' ? handler.name : undefined
  return {...(name ? {name} : {}), source: handler.toString()}
}
