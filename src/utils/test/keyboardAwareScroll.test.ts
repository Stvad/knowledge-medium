import { describe, expect, it } from 'vitest'
import { shouldReassertCaret } from '@/utils/keyboardAwareScroll'

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
