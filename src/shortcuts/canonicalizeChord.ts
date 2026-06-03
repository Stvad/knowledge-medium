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

/**
 * One press within a chord. A plain chord ('Cmd+K') is a single
 * descriptor; a sequence ('g g') is several. `kind` stays open so Phase 3
 * can add `'mouse' | 'touch'` variants rather than forcing a rewrite.
 */
export interface ChordDescriptor {
  readonly kind: 'key'
  /** Canonical final key, original case preserved ('k', 'K', 'Escape'). */
  readonly key: string
  /** Alias-folded and sorted into `MODIFIER_ORDER`. */
  readonly mods: readonly Modifier[]
  readonly phase: ChordPhase
}

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
