/**
 * Pure helpers for converting a KeyboardEvent into a tinykeys chord
 * string.
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

import { isMacPlatform } from '@/utils/platform.js'
export { isMacPlatform }

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

// Includes lock/AltGr/dead keys: they never resolve a chord on their own,
// and treating e.g. AltGraph (ordinary typing on many European layouts) as
// a key would commit bogus captures and reset pending sequence buffers.
const MODIFIER_KEYS = new Set(['control', 'meta', 'os', 'alt', 'shift', 'altgraph', 'capslock', 'numlock', 'dead'])

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

/** Held modifiers as ordered canonical tokens — the platform-swapped
 *  primary/secondary rules shared by `chordFromEvent` and
 *  `modifierPreview`, so the two can't drift. */
const modifierParts = (
  event: Pick<ChordEventShape, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): string[] => {
  const onMac = isMacPlatform()
  const parts: string[] = []
  const isPrimaryMod = onMac ? event.metaKey : event.ctrlKey
  const isSecondaryMod = onMac ? event.ctrlKey : event.metaKey
  if (isPrimaryMod) parts.push('$mod')
  if (isSecondaryMod) parts.push(onMac ? 'Control' : 'Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return parts
}

/** Build a tinykeys chord string from a KeyboardEvent. Returns null
 *  when the event is modifier-only (no actionable chord yet). */
export const chordFromEvent = (event: ChordEventShape): string | null => {
  if (isModifierOnly(event)) return null

  const parts = modifierParts(event)

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

/** Preview chord for held modifiers only ('$mod+Shift'), built from the
 *  same `modifierParts` core as `chordFromEvent` so the preview glyphs
 *  match what a completed chord will capture. Null when no modifier is
 *  held. Shared by every surface that shows a "⌘…" style hint
 *  (KeyCaptureInput, shortcut-help's inspector). */
export const modifierPreview = (
  event: Pick<ChordEventShape, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): string | null => {
  const parts = modifierParts(event)
  return parts.length ? parts.join('+') : null
}

// `normalizeChord` now lives in the shared canonicaliser so dedup,
// conflict detection, and the resolver all compare chords identically.
// Re-exported here so the settings UI keeps a single import surface.
export { normalizeChord } from '@/shortcuts/canonicalizeChord.js'
