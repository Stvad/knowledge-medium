import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import {
  endKeyboardScrub,
  installDateScrubAuxListeners,
  registerScrubHandler,
  startKeyboardScrubForTarget,
  type ScrubHandler,
} from '../dateScrubGesture.ts'

// The two-finger TOUCH path is the date-scrub RECOGNIZER now (see
// dateScrubRecognizer.test.ts); this file covers the scrub CORE that stays put:
// the registered ScrubHandler + the keyboard/wheel scrub's window-level feeders
// (wheel deltas while armed, blur cancel) that don't fit the action substrate.

describe('date scrub aux listeners (wheel feeder + blur cancel)', () => {
  let unregisterHandler: (() => void) | null = null
  let unregisterAux: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregisterHandler = registerScrubHandler(handler)
    unregisterAux = installDateScrubAuxListeners()
  })

  afterEach(() => {
    unregisterAux?.()
    unregisterAux = null
    unregisterHandler?.()
    unregisterHandler = null
    // Module-level scrub state leaks across tests; clear it explicitly.
    endKeyboardScrub(false)
    document.body.innerHTML = ''
  })

  it('ignores wheel events when no scrub is armed', () => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      cancelable: true,
    }))

    expect(handler.start).not.toHaveBeenCalled()
    expect(handler.update).not.toHaveBeenCalled()
  })

  it('feeds wheel deltas to an already-armed scrub', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})
    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('uses horizontal wheel delta when shift remaps vertical wheel motion', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: -14,
      deltaY: 0,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('cancels on window blur while armed', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})
    expect(handler.start).toHaveBeenCalled()

    window.dispatchEvent(new Event('blur'))
    expect(handler.end).toHaveBeenCalledWith(false)
  })
})
