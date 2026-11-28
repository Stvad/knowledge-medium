import { isMacPlatform } from '@/utils/platform.js'
import { splitPressTokens } from './canonicalizeChord.js'

const MODIFIER_LABELS: Record<string, readonly [apple: string, other: string]> = {
  $mod: ['⌘', 'Ctrl'],
  cmd: ['⌘', 'Meta'],
  meta: ['⌘', 'Meta'],
  os: ['⌘', 'Meta'],
  control: ['⌃', 'Ctrl'],
  ctrl: ['⌃', 'Ctrl'],
  alt: ['⌥', 'Alt'],
  option: ['⌥', 'Alt'],
  shift: ['⇧', 'Shift'],
}

const KEY_GLYPHS: Record<string, string> = {
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

/** `KeyboardEvent.code` names for punctuation keys, mapped to their US
 *  glyph for display — bindings authored code-form ('Control+Shift+
 *  Backquote') would otherwise render the raw code word. */
const CODE_KEY_GLYPHS: Record<string, string> = {
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
}

/** Strip tinykeys' `KeyX`/`DigitN` code prefixes for display, so
 *  `KeyY` shows as `Y` and `Digit3` as `3`; punctuation code names map
 *  to their glyph. */
const stripCodePrefix = (part: string): string => {
  const letter = part.match(/^Key([A-Z])$/)
  if (letter) return letter[1]!
  const digit = part.match(/^Digit(\d)$/)
  if (digit) return digit[1]!
  return CODE_KEY_GLYPHS[part] ?? part
}

/** Render a chord with platform-specific modifier labels. Spaces separate
 *  successive presses, as in 'Ctrl+K Ctrl+S'. */
export const formatChord = (chord: string): string => {
  const onMac = isMacPlatform()
  return chord.split(' ').map(press =>
    splitPressTokens(press)
      .map(part => {
        const lower = part.toLowerCase()
        const modifier = MODIFIER_LABELS[lower]
        if (modifier) return modifier[onMac ? 0 : 1]
        const glyph = KEY_GLYPHS[lower]
        if (glyph) return glyph
        const stripped = stripCodePrefix(part)
        if (stripped.length === 1) return stripped.toUpperCase()
        return stripped.charAt(0).toUpperCase() + stripped.slice(1)
      })
      .join(onMac ? '' : '+'),
  ).join(' ')
}
