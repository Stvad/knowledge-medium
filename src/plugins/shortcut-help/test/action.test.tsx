// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { shortcutHelpAction } from '../index.ts'
import { shortcutHelpToggle } from '../toggleStore.ts'

/** Dispatch a keydown on `target` and hand the event back — `event.target`
 *  stays populated after dispatch, as the coordinator's handlers see it. */
const keydownOn = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {bubbles: true, ...init})
  target.dispatchEvent(event)
  return event
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

  it('opens from an editable target when a primary modifier is held ($mod+/)', () => {
    // The edit-mode-friendly chord holds Ctrl/Meta, so it is a deliberate
    // command rather than a typed character — it must open the overlay even
    // inside a text field, unlike the bare `?` declined above.
    const input = document.createElement('input')
    document.body.appendChild(input)
    const ctrl = keydownOn(input, {key: '/', ctrlKey: true})
    expect(shortcutHelpAction.handler({} as never, ctrl)).not.toBe(false)
    expect(shortcutHelpToggle.isOpen()).toBe(true)

    shortcutHelpToggle.close()
    const meta = keydownOn(input, {key: '/', metaKey: true})
    expect(shortcutHelpAction.handler({} as never, meta)).not.toBe(false)
    expect(shortcutHelpToggle.isOpen()).toBe(true)
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
