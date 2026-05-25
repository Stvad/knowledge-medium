/**
 * Pure helpers for converting a KeyboardEvent into a tinykeys chord
 * string and displaying chord strings back as Mac-friendly glyphs.
 *
 * Cross-platform on capture: the user's primary modifier (Cmd on
 * macOS, Ctrl elsewhere) is normalised to `$mod`, so a chord captured
 * on a Mac (Cmd+K) becomes `$mod+k` and works as Ctrl+K on Windows /
 * Linux without re-binding. The non-primary modifier still gets its
 * literal name (Mac `Control`; Windows/Linux `Meta`) so vim-style
 * Ctrl+D on Mac or Win+K on Windows stays addressable.
 *
 * Modifier order is stable (`$mod`, `Control` or `Meta`, `Alt`,
 * `Shift`) so the same physical chord always serialises identically.
 */

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

const MODIFIER_ORDER = ['$mod', 'Control', 'Meta', 'Alt', 'Shift'] as const

/** Map raw `KeyboardEvent.key` values to tinykeys' canonical names. */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  'arrowleft': 'ArrowLeft',
  'arrowright': 'ArrowRight',
  'arrowup': 'ArrowUp',
  'arrowdown': 'ArrowDown',
  'escape': 'Escape',
  'enter': 'Enter',
  'tab': 'Tab',
  'backspace': 'Backspace',
  'delete': 'Delete',
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'os', 'alt', 'shift'])

/** True when the event only carries a modifier — no useful chord yet,
 *  the capture input should wait for a real key. */
export const isModifierOnly = (event: Pick<KeyboardEvent, 'key'>): boolean =>
  MODIFIER_KEYS.has(event.key.toLowerCase())

export interface ChordEventShape {
  readonly key: string
  /** `KeyboardEvent.code` — the physical key id. Used to recover the
   *  logical character when `event.key` reports the shifted form
   *  (e.g. shift+3 reports key='#' but code='Digit3'). May be absent
   *  in tests; we fall back to `key` then. */
  readonly code?: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** Map `KeyboardEvent.code` to the unshifted character for the digit
 *  row, where shift replaces the digit with a punctuation glyph
 *  (3 → '#'). Restricted to digits on purpose: letters work
 *  correctly via `event.key.toLowerCase()` on every layout
 *  (Shift+E always yields key='E'), and using event.code for letters
 *  would break Colemak/Dvorak — event.code is QWERTY-position-keyed,
 *  so a Colemak user's 'E' (physical KeyF) would round-trip back to
 *  'f'. Punctuation keys (Minus, Equal, BracketLeft, …) are also
 *  skipped because their unshifted glyph varies by layout. */
const digitCodeForShift = (code: string | undefined): string | null => {
  if (!code) return null
  if (code.startsWith('Digit') && code.length === 6) return code
  return null
}

/** When Alt is held on macOS the layout produces special characters
 *  (Alt+y → ¥), so event.key is not the letter the user pressed.
 *  Fall back to event.code (`KeyY`) for letter keys so the binding
 *  matches via tinykeys' code-form path. Letter codes are the only
 *  ones we use here — punctuation codes vary by layout. */
const letterCodeForAlt = (code: string | undefined): string | null => {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code
  return null
}

/** Build a tinykeys chord string from a KeyboardEvent. Returns null
 *  when the event is modifier-only (no actionable chord yet). */
export const chordFromEvent = (event: ChordEventShape): string | null => {
  if (isModifierOnly(event)) return null

  const onMac = isMacPlatform()
  const parts: string[] = []
  const isPrimaryMod = onMac ? event.metaKey : event.ctrlKey
  const isSecondaryMod = onMac ? event.ctrlKey : event.metaKey
  if (isPrimaryMod) parts.push('$mod')
  if (isSecondaryMod) parts.push(onMac ? 'Control' : 'Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  // For digit + punctuation under Shift, prefer the physical-key code
  // — otherwise shift+3 captures as "Shift+#" on a US keyboard and
  // wouldn't match on a European layout where 3's shifted form
  // differs. For Alt+letter, the code form likewise avoids Mac's
  // Alt-transformations (Alt+y → ¥) — see letterCodeForAlt.
  const digitCode = event.shiftKey ? digitCodeForShift(event.code) : null
  const altLetterCode = event.altKey ? letterCodeForAlt(event.code) : null

  let chordKey: string
  if (digitCode) {
    chordKey = digitCode
  } else if (altLetterCode) {
    chordKey = altLetterCode
  } else {
    const rawKey = event.key.toLowerCase()
    chordKey = KEY_ALIASES[rawKey] ?? event.key
  }
  if (!chordKey) return null
  parts.push(chordKey)

  return parts.join('+')
}

const GLYPH_BY_TOKEN: Record<string, string> = {
  $mod: '⌘',
  cmd: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '⏎',
  escape: 'Esc',
  esc: 'Esc',
  space: 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  backspace: '⌫',
  delete: 'Del',
  tab: '⇥',
}

/** Strip tinykeys' `KeyX`/`DigitN` code prefixes for display, so
 *  `KeyY` shows as `Y` and `Digit3` as `3`. */
const stripCodePrefix = (part: string): string => {
  const letter = part.match(/^Key([A-Z])$/)
  if (letter) return letter[1]!
  const digit = part.match(/^Digit(\d)$/)
  if (digit) return digit[1]!
  return part
}

/** Render a chord string ('$mod+Shift+k') as display glyphs ('⌘⇧K').
 *  Letters are uppercased for visual scan-ability; modifier tokens
 *  map to their Mac-conventional glyphs. */
export const formatChord = (chord: string): string => {
  return chord.split('+')
    .map(part => {
      const lower = part.toLowerCase()
      const glyph = GLYPH_BY_TOKEN[lower]
      if (glyph) return glyph
      const stripped = stripCodePrefix(part)
      if (stripped.length === 1) return stripped.toUpperCase()
      return stripped.charAt(0).toUpperCase() + stripped.slice(1)
    })
    .join('')
}

/** Canonicalise a chord — stable modifier ordering, aliases (`cmd` →
 *  `$mod`, `Option` → `Alt`, etc.). Used to detect equivalence when
 *  checking for duplicates ('Meta+K' and '$mod+k' should match on a
 *  Mac-style binding, where Meta is the primary). */
export const normalizeChord = (chord: string): string => {
  const tokens = chord.split('+').map(t => t.trim()).filter(Boolean)
  const lowered = tokens.map(t => t.toLowerCase())
  // Letter-case retained on the final key (the trailing non-modifier
  // token). Modifier tokens always get their canonical name.
  const aliasMap: Record<string, string> = {
    cmd: '$mod',
    meta: '$mod',
    os: '$mod',
    ctrl: 'Control',
    control: 'Control',
    option: 'Alt',
    alt: 'Alt',
    shift: 'Shift',
    '$mod': '$mod',
  }
  const modifiers: string[] = []
  let key = ''
  for (let i = 0; i < tokens.length; i++) {
    const alias = aliasMap[lowered[i]!]
    if (alias && i < tokens.length - 1) {
      modifiers.push(alias)
    } else if (alias && i === tokens.length - 1) {
      // Modifier in the last slot (e.g. user typed `cmd`); preserve it
      // so we don't drop the chord. Unusual but possible during
      // partial-capture states.
      modifiers.push(alias)
    } else {
      key = tokens[i]!
    }
  }
  const orderedModifiers = MODIFIER_ORDER.filter(m => modifiers.includes(m))
  return [...orderedModifiers, key].filter(Boolean).join('+')
}
