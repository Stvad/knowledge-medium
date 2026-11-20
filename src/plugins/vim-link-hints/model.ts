import { parseKeybinding, type KeybindingPress } from 'tinykeys'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function boundPresses(
  actions: readonly ActionConfig[],
  installable: ReadonlySet<ActionContextType>,
): KeybindingPress[] {
  return actions.flatMap(({context, defaultBinding}) =>
    defaultBinding && installable.has(context)
      ? toChordArray(defaultBinding.keys).flatMap(chord => parseKeybinding(chord))
      : [],
  )
}

export function hintLetters(presses: readonly KeybindingPress[]): string {
  // One label works with every click modifier, so reserve the letter even
  // when the shortcut only uses it with modifiers or inside a sequence.
  const reserved = presses.map(([, , key]) => typeof key === 'string'
    ? key.toLowerCase()
    : new RegExp(key.source, 'i'))
  return Array.from(LETTERS).filter(letter => !reserved.some(key =>
    typeof key === 'string'
      ? key === letter || key === `key${letter}`
      : key.test(letter) || key.test(`Key${letter.toUpperCase()}`),
  )).join('')
}

export function hintLabels(letters: string, count: number): string[] {
  if (letters.length < 2) return [...letters.slice(0, count)]
  // Equal-width labels let a complete label identify exactly one link, even
  // when there are more links than free letters.
  let width = 1
  let capacity = letters.length
  while (capacity < count) {
    width++
    capacity *= letters.length
  }
  return Array.from({length: count}, (_, index) => {
    let label = ''
    for (let i = 0; i < width; i++) {
      label = letters[index % letters.length] + label
      index = Math.floor(index / letters.length)
    }
    return label
  })
}
