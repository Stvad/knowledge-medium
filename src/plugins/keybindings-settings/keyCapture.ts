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
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
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

  const rawKey = event.key.toLowerCase()
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
