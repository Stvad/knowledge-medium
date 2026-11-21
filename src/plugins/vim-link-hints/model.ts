import { parseKeybinding, type KeybindingPress } from 'tinykeys'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

interface BoundPress {
  press: KeybindingPress
  canShareLetter: boolean
}

export function boundPresses(
  actions: readonly ActionConfig[],
  installable: ReadonlySet<ActionContextType>,
): BoundPress[] {
  return actions.flatMap(({context, defaultBinding}) =>
    defaultBinding && installable.has(context)
      ? toChordArray(defaultBinding.keys).flatMap(chord => parseKeybinding(chord).map((press, index) => ({
        press,
        // A suffix only owns its chord after the prefix has been pressed.
        // Reserving its letter avoids a hint that yields to an idle sequence.
        canShareLetter: index === 0 && press[0].length > 0,
      })))
      : [],
  )
}

export function hintLetters(presses: readonly BoundPress[]): string {
  const bindings = presses.map(({press: [, , key], canShareLetter}) => ({
    canShareLetter,
    key: typeof key === 'string' ? key.toLowerCase() : new RegExp(key.source, 'i'),
  }))
  const unused: string[] = []
  const modifiedOnly: string[] = []
  for (const letter of LETTERS) {
    const matches = bindings.filter(({key}) => typeof key === 'string'
      ? key === letter || key === `key${letter}`
      : key.test(letter) || key.test(`Key${letter.toUpperCase()}`))
    if (!matches.length) unused.push(letter)
    else if (matches.every(binding => binding.canShareLetter)) modifiedOnly.push(letter)
  }
  // Prefer labels that work with every click modifier. Additional labels
  // share a letter with a shortcut only when its plain press is free.
  return [...unused, ...modifiedOnly].join('')
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
