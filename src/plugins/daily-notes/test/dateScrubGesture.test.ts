import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import {
  installDateKeyboardScrubListeners,
  registerScrubHandler,
  type ScrubHandler,
} from '../dateScrubGesture.ts'

const setMobileViewport = (matches: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

describe('date scrub keyboard gesture', () => {
  let unregisterHandler: (() => void) | null = null
  let unregisterKeyboard: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    setMobileViewport(false)
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregisterHandler = registerScrubHandler(handler)
    unregisterKeyboard = installDateKeyboardScrubListeners(() => ({
      block: {id: 'dated-block'} as Block,
    }))
  })

  afterEach(() => {
    unregisterKeyboard?.()
    unregisterKeyboard = null
    unregisterHandler?.()
    unregisterHandler = null
    document.body.innerHTML = ''
  })

  it('starts when ctrl and shift are both held and commits on modifier release', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Control',
      ctrlKey: true,
    }))
    expect(handler.start).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))
    expect(handler.update).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Shift',
      ctrlKey: true,
    }))

    expect(handler.end).toHaveBeenCalledWith(true)
  })

  it('maps up/down and h/k to one-day increments', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(2, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(0, false)
  })

  it('maps left/right and j/l to one-week increments', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Control',
      ctrlKey: true,
      shiftKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(7, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(14, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(7, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      shiftKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(0, false)
  })

  it('cancels an active keyboard scrub on Escape', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))

    expect(handler.end).toHaveBeenCalledWith(false)
  })

  it('prevents default handling for scrub movement keys', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(preventDefault).toHaveBeenCalled()
  })

  it('updates an active keyboard scrub from ctrl-shift vertical wheel events', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('uses horizontal wheel delta when shift remaps vertical wheel motion', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift',
      ctrlKey: true,
      shiftKey: true,
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: -14,
      deltaY: 0,
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })
})
