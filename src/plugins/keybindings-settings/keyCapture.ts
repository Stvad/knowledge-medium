/**
 * Pure helpers for converting a KeyboardEvent into a hotkeys-js chord
 * string and displaying chord strings back as Mac-friendly glyphs.
 *
 * Kept platform-agnostic where reasonable: we emit `cmd` for the
 * Meta key (hotkeys-js' canonical Mac modifier) but recognise `meta`
 * as an alias on decode so a chord saved on macOS still resolves on
 * Linux/Windows builds. Modifier order is stable (cmd, ctrl, alt,
 * shift) so the same physical chord always serialises identically.
 */

const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift'] as const

/** Map raw `KeyboardEvent.key` values to hotkeys-js' canonical names. */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  'arrowleft': 'left',
  'arrowright': 'right',
  'arrowup': 'up',
  'arrowdown': 'down',
  'escape': 'esc',
  'control': 'ctrl',
  'meta': 'cmd',
  'os': 'cmd',
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

/** Map `KeyboardEvent.code` to the unshifted character for keys
 *  that browsers report as their shifted form when modifiers are
 *  held. Restricted to letters / digits where the mapping is
 *  layout-agnostic enough to be reliable — punctuation keys (Minus,
 *  Equal, …) are skipped on purpose because their unshifted glyph
 *  varies by keyboard layout. */
const codeToLogicalKey = (code: string | undefined): string | null => {
  if (!code) return null
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toLowerCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5)
  }
  return null
}

/** Build a hotkeys-js chord string from a KeyboardEvent. Returns null
 *  when the event is modifier-only (no actionable chord yet). */
export const chordFromEvent = (event: ChordEventShape): string | null => {
  if (isModifierOnly(event)) return null

  const parts: string[] = []
  if (event.metaKey) parts.push('cmd')
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')

  // Prefer the physical-key fallback when shift is held — otherwise
  // shift+3 captures as "shift+#" on a US keyboard (and locale-specific
  // gibberish elsewhere). Without shift, event.key is already correct
  // and respects the user's layout.
  const logical = event.shiftKey ? codeToLogicalKey(event.code) : null
  const rawKey = (logical ?? event.key).toLowerCase()
  const key = KEY_ALIASES[rawKey] ?? rawKey
  if (!key) return null
  parts.push(key)

  return parts.join('+')
}

const GLYPH_BY_TOKEN: Record<string, string> = {
  cmd: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '⏎',
  esc: 'Esc',
  space: 'Space',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  backspace: '⌫',
  delete: 'Del',
  tab: '⇥',
}

/** Render a chord string ("cmd+shift+k") as display glyphs ("⌘⇧K").
 *  Letters are uppercased for visual scan-ability; modifier tokens
 *  map to their Mac-conventional glyphs. */
export const formatChord = (chord: string): string => {
  return chord.split('+')
    .map(part => {
      const lower = part.toLowerCase()
      const glyph = GLYPH_BY_TOKEN[lower]
      if (glyph) return glyph
      if (lower.length === 1) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/** Canonicalise a chord — lowercase tokens, stable modifier ordering,
 *  meta aliased to cmd. Used to detect equivalence when checking for
 *  duplicates ('Meta+K' and 'cmd+k' should match). */
export const normalizeChord = (chord: string): string => {
  const tokens = chord.split('+').map(t => t.trim().toLowerCase()).filter(Boolean)
  const normalized = tokens.map(t => (t === 'meta' || t === 'os' ? 'cmd' : t === 'option' ? 'alt' : t === 'control' ? 'ctrl' : t))
  const modifiers = normalized.filter(t => (MODIFIER_ORDER as readonly string[]).includes(t))
  const keys = normalized.filter(t => !(MODIFIER_ORDER as readonly string[]).includes(t))
  const orderedModifiers = MODIFIER_ORDER.filter(m => modifiers.includes(m))
  return [...orderedModifiers, ...keys].join('+')
}
