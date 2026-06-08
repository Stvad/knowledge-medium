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
 * literal. `cmd`/`meta`/`os` all alias-fold to `$mod`, so `Meta` never
 * survives canonicalisation.
 */
export type Modifier = '$mod' | 'Control' | 'Alt' | 'Shift'

/** When in the key lifecycle a press resolves. Mirrors the binding
 *  `phase` field in `types.ts`. */
export type ChordPhase = 'keydown' | 'keyup' | 'hold'

/** When in the pointer lifecycle a mouse/touch press resolves. A
 *  double-click binds at `pointerdown` to beat the browser's native
 *  text-selection, which `click` is too late for. */
export type PointerPhase = 'pointerdown' | 'pointerup' | 'click'

/**
 * One keyboard press within a chord. A plain chord ('Cmd+K') is a single
 * descriptor; a sequence ('g g') is several.
 */
export interface KeyChordDescriptor {
  readonly kind: 'key'
  /** Canonical final key, original case preserved ('k', 'K', 'Escape'). */
  readonly key: string
  /** Alias-folded and sorted into `MODIFIER_ORDER`. */
  readonly mods: readonly Modifier[]
  readonly phase: ChordPhase
}

/**
 * A single mouse/touch press. The pointer-side analogue of
 * {@link KeyChordDescriptor}: `button`/`detail` replace `key`, the modifier
 * model is shared (exact-set match — shift-click is `mods: ['Shift']` and does
 * NOT match a ctrl+shift-click). `role` optionally constrains which bound node
 * the press targets and is matched by the coordinator against the node, not by
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
 * One press within a chord. `kind` discriminates keyboard from pointer; the
 * field was left open in Phase 0 precisely so Phase 3 could add this variant
 * without a rewrite.
 */
export type ChordDescriptor = KeyChordDescriptor | MouseChordDescriptor

/** A chord is a sequence of presses; an ordinary chord is length 1. */
export type ChordSequence = readonly ChordDescriptor[]

/** Stable modifier order, so the same physical chord always serialises
 *  identically. `$mod` first, then the literal modifiers. */
const MODIFIER_ORDER: readonly Modifier[] = ['$mod', 'Control', 'Alt', 'Shift']

/** Fold the assorted spellings of each modifier onto one canonical name. */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: '$mod',
  meta: '$mod',
  os: '$mod',
  '$mod': '$mod',
  ctrl: 'Control',
  control: 'Control',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
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
    const alias = MODIFIER_ALIASES[token.toLowerCase()]
    if (alias) {
      mods.push(alias)
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
 * Canonicalise a whole chord, sequence-aware: splits on space first, then
 * canonicalises each press, so 'Cmd+K Cmd+S' becomes '$mod+k $mod+s'
 * instead of being mangled by a naive `+` split. Returns a stable string
 * key for bucketing/dedup. When `phase` is supplied it is folded into the
 * key, so the same chord on different phases (hold `s` vs keyup `s`) does
 * not collapse together.
 */
export const canonicalizeChord = (raw: string, phase?: ChordPhase): string => {
  const canonical = splitSequence(raw)
    .map(press => formatPress(parsePress(press)))
    .join(' ')
  return phase ? `${phase}:${canonical}` : canonical
}

/**
 * Parse a chord into an ordered sequence of descriptors for matching.
 * Splits on space first, so 'd d' / 'g g' become two presses instead of
 * one atomic key — the historical cause of dead sequence chords. Plain
 * chords yield a length-1 sequence.
 */
export const parseChord = (raw: string, phase: ChordPhase = 'keydown'): ChordSequence =>
  splitSequence(raw).map(press => {
    const {mods, key} = parsePress(press)
    return {kind: 'key', key, mods, phase}
  })

/** Platform-primary detection for `$mod` (Cmd on Apple, Ctrl elsewhere),
 *  mirroring tinykeys so keyboard and pointer agree on what `$mod` means. */
const platformPrimaryIsMeta = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '')

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
