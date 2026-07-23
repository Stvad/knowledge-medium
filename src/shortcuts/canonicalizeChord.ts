/**
 * Shared chord canonicalisation for the action/shortcut system.
 *
 * Lifted out of `keybindings-settings/keyCapture.ts` (which re-exports
 * `normalizeChord` for back-compat) so that dedup, conflict detection,
 * and — in later phases — the resolver all compare chords the same way.
 *
 * Two levels of structure:
 *  - A single *press* ('Cmd+Shift+K') alias-folds its modifiers
 *    (cmd|meta|os → $mod, ctrl → Control, option → Alt), sorts them into
 *    a stable order, and keeps the final key's case. That already worked
 *    here; this is a relocation, not a fix.
 *  - A *chord* is a SEQUENCE of presses separated by spaces ('g g',
 *    'Cmd+K Cmd+S'). The lifted splitter only ever split on '+', so a
 *    space-bearing chord like 'd d' was treated as one atomic key — that
 *    is the real gap this module closes. Split on space FIRST, then
 *    canonicalise each press.
 */

/**
 * Canonical modifier names a descriptor can carry. `$mod` is the
 * platform-primary modifier (Cmd on macOS, Ctrl elsewhere); the rest are
 * literal. `cmd`/`meta`/`os` fold to `$mod` ONLY on macOS, where the Meta
 * key IS the primary. Off-Mac the Meta/Super key is a distinct modifier
 * that tinykeys dispatches as `Meta` (Ctrl is `$mod` there), so it survives
 * canonicalisation as a literal `Meta` — folding it into `$mod` would make
 * conflict detection treat Super+K and Ctrl+K as the same chord.
 */
export type Modifier = '$mod' | 'Control' | 'Meta' | 'Alt' | 'Shift'

/** When in the key lifecycle a press resolves. Mirrors the binding
 *  `phase` field in `types.ts`. */
export type ChordPhase = 'keydown' | 'keyup' | 'hold'

/** When in the pointer lifecycle a mouse press resolves. A
 *  double-click binds at `pointerdown` to beat the browser's native
 *  text-selection, which `click` is too late for. */
export type PointerPhase = 'pointerdown' | 'pointerup' | 'click'

/** When in the touch lifecycle a gesture resolves. Only `tap` today — the
 *  block surface recognises the tap (its movement/duration thresholds live
 *  there, not in the descriptor) and dispatches at touchend. Kept a separate
 *  phase set from {@link PointerPhase} because a tap is not a mouse press and
 *  carries none of button/detail/modifiers. */
export type TouchPhase = 'tap'

/**
 * A single mouse/touch press. `button`/`detail` take the place of a
 * keyboard key; the modifier model matches keyboard chords (exact-set
 * match — shift-click is `mods: ['Shift']` and does NOT match a
 * ctrl+shift-click). `role` optionally constrains which bound node the
 * press targets and is matched by the coordinator against the node, not by
 * the pure matcher here.
 */
export interface MouseChordDescriptor {
  readonly kind: 'mouse'
  /** Pressed button: 0 primary, 1 middle, 2 secondary (matches `MouseEvent.button`). */
  readonly button: number
  /** Click count to match: 1 single, 2 double (matches `MouseEvent.detail`). */
  readonly detail: number
  /** Exact modifier set required, alias-folded as for keyboard. */
  readonly mods: readonly Modifier[]
  /** Optional semantic role the bound node must carry; matched by the
   *  coordinator, not by {@link matchesMouseEvent}. */
  readonly role?: string
  readonly phase: PointerPhase
}

/**
 * A single touch gesture. The touch-side analogue of {@link MouseChordDescriptor}:
 * a tap has no button/detail/modifiers, so `phase` is the only matched field.
 * Recognising the tap (movement/duration thresholds) is the surface's job; by
 * the time a descriptor is compared the gesture has already been classified.
 */
export interface TouchChordDescriptor {
  readonly kind: 'touch'
  readonly phase: TouchPhase
}

/** Platform-primary detection for `$mod` (Cmd on Apple, Ctrl elsewhere),
 *  mirroring tinykeys so keyboard and pointer agree on what `$mod` means. */
const platformPrimaryIsMeta = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '')

/** Stable modifier order, so the same physical chord always serialises
 *  identically. `$mod` first, then the literal modifiers (`Meta` in the
 *  secondary slot, mirroring how chordFromEvent orders the captured chord). */
const MODIFIER_ORDER: readonly Modifier[] = ['$mod', 'Control', 'Meta', 'Alt', 'Shift']

/** Fold one modifier spelling onto its canonical name, or null if the token
 *  isn't a modifier. `meta`/`os` (the Meta/Super key) are platform-aware: on
 *  a Mac they ARE the primary and fold to `$mod`; off-Mac they're the
 *  distinct Super/Windows key that tinykeys dispatches as `Meta`, so folding
 *  them into `$mod` (= Ctrl there) would collapse two different chords. */
const resolveModifier = (token: string): Modifier | null => {
  switch (token.toLowerCase()) {
    case '$mod':
    case 'cmd':
      return '$mod'
    case 'meta':
    case 'os':
      return platformPrimaryIsMeta() ? '$mod' : 'Meta'
    case 'ctrl':
    case 'control':
      return 'Control'
    case 'option':
    case 'alt':
      return 'Alt'
    case 'shift':
      return 'Shift'
    default:
      return null
  }
}

interface ParsedPress {
  readonly mods: readonly Modifier[]
  readonly key: string
}

/** Parse a single press ('Cmd+Shift+K') into ordered, alias-folded
 *  modifiers plus the final key (case preserved). Modifier tokens in any
 *  position fold to a modifier; the remaining token is the key. */
const parsePress = (press: string): ParsedPress => {
  const tokens = press.split('+').map(t => t.trim()).filter(Boolean)
  const mods: Modifier[] = []
  let key = ''
  for (const token of tokens) {
    const mod = resolveModifier(token)
    if (mod) {
      mods.push(mod)
    } else {
      key = token
    }
  }
  // Filtering `MODIFIER_ORDER` both orders the modifiers and dedups them.
  return {mods: MODIFIER_ORDER.filter(m => mods.includes(m)), key}
}

/** Split a chord into its presses. A chord is space-separated presses
 *  ('g g'); ordinary chords yield a single press. */
const splitSequence = (raw: string): string[] =>
  raw.split(' ').map(p => p.trim()).filter(Boolean)

/** Normalise a binding's `keys` field (one chord or a list) to a list.
 *  The single shared copy — keybinding overrides, conflict detection, and
 *  the shortcut-help model all expand bindings the same way. */
export const toChordArray = (keys: string | readonly string[]): readonly string[] =>
  typeof keys === 'string' ? [keys] : keys

/** Serialise a parsed press back to its canonical chord string. */
const formatPress = ({mods, key}: ParsedPress): string =>
  [...mods, key].filter(Boolean).join('+')

/**
 * Canonicalise a single press — stable modifier ordering, alias folding
 * (`cmd` → `$mod`, `Option` → `Alt`, …). Used to detect equivalence when
 * checking for duplicates ('Meta+K' and '$mod+k' match on a Mac-style
 * binding, where Meta is the primary).
 *
 * Kept single-press (splits on `+` only) for the settings UI, which
 * re-exports it via `keyCapture.ts` and feeds it one press at a time. For
 * sequence-aware canonicalisation use `canonicalizeChord`.
 */
export const normalizeChord = (chord: string): string =>
  formatPress(parsePress(chord))

/**
 * Sequence-aware `normalizeChord` — normalises each space-separated press.
 * Unlike `canonicalizeChord` (a COMPARISON key: also case-folds the final
 * key), the output preserves the key's authored case, so it is the right
 * form for INSTALLING a binding: modifier aliases fold to the names
 * tinykeys actually dispatches (`ctrl` → `Control`, `cmd` → `$mod`) while
 * the display spelling stays intact (`ArrowDown`, not `arrowdown`).
 * Canonical-bucket agreement holds by construction:
 * `canonicalizeChord(normalizeChordSequence(c)) === canonicalizeChord(c)`
 * (both sides run the same parse/format; canonicalize just adds the case
 * fold) — pinned by keybindingOverrides.fuzz.test.ts.
 */
export const normalizeChordSequence = (chord: string): string =>
  splitSequence(chord).map(normalizeChord).join(' ')

/**
 * `KeyboardEvent.code` key tokens that tinykeys can only match through its
 * case-SENSITIVE `event.code` path, because their `event.key` differs from
 * the token: code `Digit1`→key `'1'`, `Period`→`'.'`, `Space`→`' '`,
 * `KeyA`→`'a'`, `Numpad3`→`'3'`. tinykeys tries `token.toUpperCase() ===
 * event.key.toUpperCase()` OR `token === event.code` (tinykeys `matchKeybindingPress`),
 * so a mis-cased spelling like `digit1` matches NEITHER — it never fires.
 * Folding these to lowercase in the canonical key would therefore (a) claim
 * `Digit1` and `digit1` are the same binding when only the former dispatches,
 * letting a dead `digit1` override strip a live `Digit1` default, and (b) is
 * meaningless anyway since the real binding must be exact-cased. Named keys
 * whose `event.key` EQUALS the code (`Enter`, `Tab`, `Escape`, `Backspace`,
 * `ArrowUp`, `F5`, …) are NOT here: they still match via the case-insensitive
 * `event.key` path, so folding them is safe and keeps mis-cased spellings in
 * one bucket. */
const CODE_ONLY_KEY =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad\w+|Space|Period|Comma|Slash|Backslash|Semicolon|Quote|Backquote|Minus|Equal|BracketLeft|BracketRight|Intl[A-Za-z]+)$/

/**
 * Canonicalise a whole chord, sequence-aware: splits on space first, then
 * canonicalises each press, so 'Cmd+K Cmd+S' becomes '$mod+k $mod+s'
 * instead of being mangled by a naive `+` split. Returns a stable string
 * key for bucketing/dedup. When `phase` is supplied it is folded into the
 * key, so the same chord on different phases (hold `s` vs keyup `s`) does
 * not collapse together.
 */
export const canonicalizeChord = (raw: string, phase?: ChordPhase): string => {
  const canonical = splitSequence(raw)
    // Fold the final key's CASE too, unlike `normalizeChord`: tinykeys
    // dispatch compares `key.toUpperCase() === event.key.toUpperCase()`,
    // so '$mod+K' and '$mod+k' are the same binding at dispatch and must
    // land in the same bucket here (strip map, conflict detection).
    // `normalizeChord` stays case-preserving — the settings UI stores and
    // round-trips the user's spelling. EXCEPTION: {@link CODE_ONLY_KEY}
    // tokens match only via tinykeys' case-sensitive `event.code` path, so
    // folding them would corrupt the binding and forge false collisions —
    // those keep their case.
    .map(press => {
      const {mods, key} = parsePress(press)
      return formatPress({mods, key: CODE_ONLY_KEY.test(key) ? key : key.toLowerCase()})
    })
    .join(' ')
  return phase ? `${phase}:${canonical}` : canonical
}

// NOTE: keyboard EVENT matching is deliberately NOT re-implemented here.
// Matching a KeyboardEvent against a chord is tinykeys' job
// (`parseKeybinding` / `matchKeybindingPress`) — a hand-rolled keyboard
// descriptor family used to live in this module and diverged from
// tinykeys' semantics (event.code fallback, $mod platform resolution),
// which is exactly the bug class that got it removed. This module keeps
// chord-STRING canonicalisation plus the pointer/touch descriptors, which
// have no tinykeys equivalent.

/** The four physical modifier flags a pointer event carries. */
export interface PointerModifierState {
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/** Expand a canonical modifier set to the four physical flags it requires,
 *  resolving `$mod` to the platform-primary key. Exact-match semantics: a flag
 *  not listed must be absent on the event. */
const requiredModifierFlags = (mods: readonly Modifier[]): PointerModifierState => {
  const primaryIsMeta = platformPrimaryIsMeta()
  let shiftKey = false, altKey = false, ctrlKey = false, metaKey = false
  for (const mod of mods) {
    if (mod === 'Shift') shiftKey = true
    else if (mod === 'Alt') altKey = true
    else if (mod === 'Control') ctrlKey = true
    else if (mod === 'Meta') metaKey = true
    else if (mod === '$mod') {
      if (primaryIsMeta) metaKey = true
      else ctrlKey = true
    }
  }
  return {shiftKey, altKey, ctrlKey, metaKey}
}

/** The pointer-event shape {@link matchesMouseEvent} reads. Structural so the
 *  matcher stays pure (no React/DOM import) and unit-testable. */
export interface MouseEventLike extends PointerModifierState {
  readonly button: number
  readonly detail: number
}

/**
 * A mouse binding declared on an action — the pointer analogue of a keyboard
 * `defaultBinding`. Structured rather than a string because pointer chords
 * aren't sequences and don't share keyboard's phase set. Defaults: primary
 * button, single click, no modifiers, `click` phase.
 */
export interface MousePointerBindingSpec {
  readonly kind: 'mouse'
  readonly button?: number
  readonly detail?: number
  readonly mods?: readonly Modifier[]
  readonly role?: string
  readonly phase?: PointerPhase
}

/**
 * A touch binding declared on an action. A tap carries none of mouse's
 * button/detail/modifiers, so the spec is just the kind plus an optional phase
 * (only `tap` today). Defaults: `tap` phase.
 */
export interface TouchPointerBindingSpec {
  readonly kind: 'touch'
  readonly phase?: TouchPhase
}

/**
 * A pointer binding declared on an action — a mouse gesture (click, ctrl-click,
 * double-click, …) or a touch gesture (tap). Both dispatch through the same
 * `resolve` + coordinator path with the clicked/tapped block's deps supplied.
 */
export type PointerBindingSpec = MousePointerBindingSpec | TouchPointerBindingSpec

/** Realize a {@link PointerBindingSpec}'s declared/defaulted fields into the
 *  descriptor the matcher and coordinator compare against. */
export const pointerBindingDescriptor = (
  spec: PointerBindingSpec,
): MouseChordDescriptor | TouchChordDescriptor =>
  spec.kind === 'touch'
    ? {kind: 'touch', phase: spec.phase ?? 'tap'}
    : {
        kind: 'mouse',
        button: spec.button ?? 0,
        detail: spec.detail ?? 1,
        mods: spec.mods ?? [],
        ...(spec.role !== undefined ? {role: spec.role} : {}),
        phase: spec.phase ?? 'click',
      }

/**
 * Does a mouse event satisfy a {@link MouseChordDescriptor}? Button and click
 * count match exactly, and the modifier set matches exactly — `mods: ['Shift']`
 * requires Shift held and Ctrl/Alt/Meta absent, so shift-click (extend
 * selection) and ctrl-click (toggle selection) never collide. `role` is the
 * coordinator's concern (it constrains the bound node), so it isn't consulted
 * here.
 */
export const matchesMouseEvent = (
  descriptor: MouseChordDescriptor,
  event: MouseEventLike,
): boolean => {
  if (event.button !== descriptor.button) return false
  if (event.detail !== descriptor.detail) return false
  const required = requiredModifierFlags(descriptor.mods)
  return (
    event.shiftKey === required.shiftKey &&
    event.altKey === required.altKey &&
    event.ctrlKey === required.ctrlKey &&
    event.metaKey === required.metaKey
  )
}
