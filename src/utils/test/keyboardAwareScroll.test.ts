// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { keyboardAwareScroll, shouldReassertCaret } from '@/utils/keyboardAwareScroll'
import { setEditingToolbarHeight } from '@/utils/keyboardViewport'

// The on-device bug this guards: on iOS, re-asserting the caret on a pure
// scroll fed a 60fps loop, because scrolling the caret into view itself moves
// the visual viewport offset and fires another `scroll`. shouldReassertCaret
// breaks that by re-asserting only on a *geometry* change (keyboard/toolbar
// height), never on a pure offset move.
describe('shouldReassertCaret', () => {
  const KEYBOARD = 300 // a real keyboard's overlap, well above MIN
  const NOISE = 10 // sub-MIN viewport jitter (URL bar, rounding)

  it('does NOT re-assert on a pure scroll (geometry unchanged) — the loop guard', () => {
    // Keyboard up, nothing about the geometry changed, only the offset moved.
    expect(
      shouldReassertCaret(
        {vvHeight: 320, toolbarHeight: 0},
        {vvHeight: 320, toolbarHeight: 0, keyboardOverlap: KEYBOARD},
      ),
    ).toBe(false)
  })

  it('re-asserts when the keyboard opens (visual viewport height shrinks)', () => {
    expect(
      shouldReassertCaret(
        {vvHeight: 748, toolbarHeight: 0},
        {vvHeight: 320, toolbarHeight: 0, keyboardOverlap: KEYBOARD},
      ),
    ).toBe(true)
  })

  it('re-asserts when the editing toolbar mounts even if the keyboard overlap stays 0 (Chrome resizes-content)', () => {
    expect(
      shouldReassertCaret(
        {vvHeight: 500, toolbarHeight: 0},
        {vvHeight: 500, toolbarHeight: 48, keyboardOverlap: 0},
      ),
    ).toBe(true)
  })

  it('does NOT re-assert on a sub-keyboard geometry blip with no toolbar (URL-bar jitter)', () => {
    expect(
      shouldReassertCaret(
        {vvHeight: 800, toolbarHeight: 0},
        {vvHeight: 790, toolbarHeight: 0, keyboardOverlap: NOISE},
      ),
    ).toBe(false)
  })
})

/** Minimal visualViewport stand-in whose listeners we can fire by hand. */
const installViewport = (height: number) => {
  const listeners = new Map<string, Set<() => void>>()
  const vv = {
    height,
    offsetTop: 0,
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
    emit: (type: string) => listeners.get(type)?.forEach(cb => cb()),
  }
  vi.stubGlobal('visualViewport', vv)
  return vv
}

// Guards the actual ViewPlugin WIRING (subscribe → gate → dispatch), not just
// the pure helper above. The original bug lived here: re-asserting on every
// viewport notification looped at 60fps. The decisive property is that a pure
// scroll after a re-assert produces NO further dispatch — reverting the gate to
// "always dispatch" must turn this red.
describe('keyboardAwareScroll ViewPlugin', () => {
  let view: EditorView | null = null

  afterEach(() => {
    view?.destroy()
    view = null
    vi.unstubAllGlobals()
    setEditingToolbarHeight(0)
  })

  const mountFocused = (vvHeight: number) => {
    vi.stubGlobal('innerHeight', 800)
    const vv = installViewport(vvHeight)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      state: EditorState.create({doc: 'hello', extensions: [keyboardAwareScroll()]}),
      parent,
    })
    view.focus()
    // CM flags focusChanged from the DOM focus event but only delivers it to
    // plugins on its next update cycle; flush one so the ViewPlugin actually
    // subscribes (it gates the subscription on focus).
    view.dispatch({})
    return vv
  }

  it('re-asserts once on keyboard-open, then ignores the scroll it triggers (no loop)', () => {
    const vv = mountFocused(800) // focused, keyboard not yet up; plugin seeds vvHeight=800
    expect(view!.hasFocus).toBe(true) // precondition: the plugin only subscribes while focused

    const dispatch = vi.spyOn(view!, 'dispatch')

    // Keyboard opens: visualViewport height shrinks (a geometry change).
    vv.height = 500 // 800 - 500 = 300px overlap, well above MIN
    vv.emit('resize')
    expect(dispatch).toHaveBeenCalledTimes(1) // lifted the caret once

    // The scrollIntoView above moves the visual viewport offset on iOS, which
    // fires a `scroll`. That MUST NOT re-assert — otherwise it loops forever.
    vv.offsetTop = 40
    vv.emit('scroll')
    expect(dispatch).toHaveBeenCalledTimes(1) // still 1: the loop is broken

    // A second self-induced scroll: still nothing.
    vv.offsetTop = 80
    vv.emit('scroll')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
