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

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

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
  /** `KeyboardEvent.keyCode` — deprecated, but still populated by every
   *  browser with the *logical* letter's char code for printable letter
   *  keys (89 for 'Y' on every layout, regardless of Alt-transforms).
   *  Used to recover the typed letter when Alt or Meta has corrupted
   *  `event.key`. May be absent in tests; recovery skips when absent. */
  readonly keyCode?: number
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

/** When Alt or Meta is held the layout can produce alt-transformed
 *  chars (Mac: Alt+y → '¥'; Linux compose: Alt+y → 'ÿ'). event.keyCode
 *  still reports the logical letter's char code (89 = 'Y') on every
 *  platform AND every layout — even Colemak, where event.code reports
 *  the QWERTY-position id ('KeyO' for the user's physical 'y' key).
 *  Recover from keyCode and emit as the lowercase letter so the
 *  captured chord matches what `withRecoveredLetterKey` produces in
 *  the reconciler. Letters only — keyCode for digits/punctuation is
 *  layout-dependent in a different way. */
const ASCII_A = 65
const ASCII_Z = 90
const letterFromKeyCode = (keyCode: number | undefined): string | null => {
  if (keyCode === undefined) return null
  if (keyCode < ASCII_A || keyCode > ASCII_Z) return null
  return String.fromCharCode(keyCode).toLowerCase()
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
  // differs. For Alt/Meta + letter, recover the logical letter from
  // event.keyCode so Mac Alt-transformations (Alt+y → ¥) and Linux
  // compose-key setups don't corrupt the captured chord — see
  // letterFromKeyCode.
  const digitCode = event.shiftKey ? digitCodeForShift(event.code) : null
  const recoveredLetter = (event.altKey || event.metaKey)
    ? letterFromKeyCode(event.keyCode)
    : null

  let chordKey: string
  if (digitCode) {
    chordKey = digitCode
  } else if (recoveredLetter) {
    chordKey = recoveredLetter
  } else {
    const rawKey = event.key.toLowerCase()
    chordKey = KEY_ALIASES[rawKey] ?? event.key
  }
  if (!chordKey) return null
  parts.push(chordKey)

  return parts.join('+')
}

/** Resolved `$mod` glyph for the current platform: ⌘ on macOS (Cmd),
 *  Ctrl elsewhere. Matches what tinykeys actually binds (`Meta` on Mac,
 *  `Control` on Windows/Linux) — see PLATFORM detection in
 *  node_modules/tinykeys/dist/tinykeys.mjs. Cached at module load
 *  since platform doesn't change mid-session. */
const platformModGlyph = (): string =>
  isMacPlatform() ? '⌘' : 'Ctrl'

const GLYPH_BY_TOKEN: Record<string, string> = {
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

/** Render a chord string ('$mod+Shift+k') as display glyphs ('⌘⇧K' on
 *  Mac, 'Ctrl⇧K' on Win/Linux). `$mod` resolves to the platform-native
 *  primary modifier — mirrors what tinykeys actually binds. Multi-press
 *  sequences ('g g') keep their space separator so the glyph hint
 *  reflects "press g, then g". Letters are uppercased for scan-ability;
 *  modifier tokens map to their Mac-conventional glyphs. */
export const formatChord = (chord: string): string => {
  // Sequence chords are space-separated; format each press independently
  // and rejoin with the same separator so "g g" displays as "G G".
  return chord.split(' ').map(press =>
    press.split('+')
      .map(part => {
        if (part === '$mod') return platformModGlyph()
        const lower = part.toLowerCase()
        const glyph = GLYPH_BY_TOKEN[lower]
        if (glyph) return glyph
        const stripped = stripCodePrefix(part)
        if (stripped.length === 1) return stripped.toUpperCase()
        return stripped.charAt(0).toUpperCase() + stripped.slice(1)
      })
      .join(''),
  ).join(' ')
}

// `normalizeChord` now lives in the shared canonicaliser so dedup,
// conflict detection, and the resolver all compare chords identically.
// Re-exported here so the settings UI keeps a single import surface.
export { normalizeChord } from '@/shortcuts/canonicalizeChord.js'
