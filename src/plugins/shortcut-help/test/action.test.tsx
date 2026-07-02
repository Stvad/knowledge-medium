// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { shortcutHelpAction } from '../index.ts'
import { shortcutHelpToggle } from '../toggleStore.ts'

/** Dispatch a keydown on `target` and hand back the event as a listener
 *  saw it (so `event.target` is populated, as it is for the coordinator). */
const keydownOn = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
  let seen: KeyboardEvent | null = null
  const capture = (event: Event) => {
    seen = event as KeyboardEvent
  }
  target.addEventListener('keydown', capture)
  target.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, ...init}))
  target.removeEventListener('keydown', capture)
  return seen!
}

describe('shortcutHelpAction', () => {
  afterEach(() => {
    shortcutHelpToggle.close()
    document.body.innerHTML = ''
  })

  it('declines (returns false) when the chord arrives from an editable target', () => {
    // The coordinator's dispatch is green-lit wholesale by any active
    // context's eventFilter (EDIT_MODE_CM opts in everything inside
    // .cm-editor), so the handler itself must decline — otherwise typing
    // `?` in a note opens the overlay and eats the character.
    const input = document.createElement('input')
    document.body.appendChild(input)
    const event = keydownOn(input, {key: '?', shiftKey: true})

    const result = shortcutHelpAction.handler({} as never, event)
    expect(result).toBe(false)
    expect(shortcutHelpToggle.isOpen()).toBe(false)
  })

  it('toggles from non-editable keyboard targets and imperative triggers', () => {
    const event = keydownOn(document.body, {key: '?', shiftKey: true})
    shortcutHelpAction.handler({} as never, event)
    expect(shortcutHelpToggle.isOpen()).toBe(true)

    // Palette/imperative dispatch (CustomEvent trigger) always toggles.
    shortcutHelpAction.handler({} as never, new CustomEvent('command-pallet-trigger'))
    expect(shortcutHelpToggle.isOpen()).toBe(false)
  })
})
