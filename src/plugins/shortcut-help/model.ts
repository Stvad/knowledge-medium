/**
 * Pure model for the shortcut-help overlay (the Doom-style `?` popup).
 *
 * Two responsibilities, both DOM-free so they unit-test without a browser:
 *
 *  - `buildShortcutHelpModel` — flatten the effective action list into
 *    per-active-context groups of keyboard bindings, ordered by the SAME
 *    precedence core the dispatcher uses (`compareContexts`), with modal
 *    shadowing marked via `computeInstallableContexts`. The overlay is a
 *    truthful mirror of what a keypress would actually do, not a separate
 *    hand-maintained cheat sheet.
 *
 *  - `matchPressedSequence` — sequence-aware lookup of a pressed-chords
 *    buffer against those bindings: exact completions plus the bindings the
 *    buffer is a proper prefix of (the which-key narrowing for `g g`-style
 *    sequence chords).
 *
 * Matching approximates tinykeys with the shared chord canonicaliser
 * (`parseChord`) over the canonical chord strings `chordFromEvent` emits.
 * It deliberately ignores the dispatch-time gates that need live deps
 * (`canDispatch`, per-context `eventFilter`) — the popup answers "what is
 * this chord bound to", not "would it no-op right now".
 */
import {
  parseChord,
  type ChordPhase,
  type ChordSequence,
  type KeyChordDescriptor,
} from '@/shortcuts/canonicalizeChord.js'
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
  /** Parsed presses — length > 1 for sequence chords. */
  readonly sequence: ChordSequence
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

const toChordList = (keys: string | readonly string[]): readonly string[] =>
  typeof keys === 'string' ? [keys] : keys

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
        return toChordList(binding.keys).map((chord): HelpBinding => ({
          action,
          contextConfig: config,
          chord,
          sequence: parseChord(chord, phase),
          phase,
          ...(binding.phase === 'hold' ? {holdMs: binding.holdMs} : {}),
          shadowed,
          ...(sourceByActionKey?.has(actionRuntimeKey(action))
            ? {source: sourceByActionKey.get(actionRuntimeKey(action))}
            : {}),
        }))
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
 *  not object identity. */
export const actionSourcesFromRuntime = (runtime: FacetRuntime): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const contribution of runtime.contributionsById(actionsFacet.id)) {
    if (!contribution.source) continue
    out.set(actionRuntimeKey(contribution.value as ActionConfig), contribution.source)
  }
  return out
}

/** Strip tinykeys' `KeyX`/`DigitN` physical-code prefixes so a code-form
 *  chord ('Shift+Digit3') and a key-form one compare on the same token. */
const keyToken = (key: string): string => {
  const letter = key.match(/^Key([A-Z])$/)
  if (letter) return letter[1]!.toLowerCase()
  const digit = key.match(/^Digit(\d)$/)
  if (digit) return digit[1]!
  return key.toLowerCase()
}

const pressesMatch = (a: KeyChordDescriptor, b: KeyChordDescriptor): boolean =>
  a.mods.length === b.mods.length &&
  // Both sides are canonicalised into the same stable modifier order.
  a.mods.every((mod, i) => b.mods[i] === mod) &&
  keyToken(a.key) === keyToken(b.key)

export interface KeyLookupResult {
  /** Bindings whose whole sequence equals the pressed buffer, best-first
   *  (the flat model order = dispatcher precedence). The first non-shadowed
   *  entry is what the coordinator would actually run. */
  readonly exact: readonly HelpBinding[]
  /** Bindings the pressed buffer is a proper prefix of — the which-key
   *  continuation set. */
  readonly pending: readonly HelpBinding[]
}

/**
 * Look up a buffer of pressed chords (canonical strings from
 * `chordFromEvent`) against the model's bindings, sequence-aware.
 */
export const matchPressedSequence = (
  bindings: readonly HelpBinding[],
  pressed: readonly string[],
): KeyLookupResult => {
  const pressedDescriptors = pressed
    .map(chord => parseChord(chord)[0])
    .filter((d): d is KeyChordDescriptor => d !== undefined && d.kind === 'key')
  if (pressedDescriptors.length === 0) return {exact: [], pending: []}

  const exact: HelpBinding[] = []
  const pending: HelpBinding[] = []
  for (const binding of bindings) {
    if (binding.sequence.length < pressedDescriptors.length) continue
    const head = binding.sequence.slice(0, pressedDescriptors.length)
    const matches = head.every((press, i) =>
      press.kind === 'key' && pressesMatch(press, pressedDescriptors[i]!),
    )
    if (!matches) continue
    if (binding.sequence.length === pressedDescriptors.length) exact.push(binding)
    else pending.push(binding)
  }
  return {exact, pending}
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
