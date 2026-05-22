import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import hotkeys from 'hotkeys-js'
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

const dispatchHotkeyKeydown = ({
  key,
  keyCode,
  ctrlKey = true,
  altKey = true,
}: {
  key: string
  keyCode: number
  ctrlKey?: boolean
  altKey?: boolean
}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    keyCode,
    which: keyCode,
    ctrlKey,
    altKey,
    bubbles: true,
    cancelable: true,
  }))
}

const dispatchHotkeyKeyup = ({
  key,
  keyCode,
  ctrlKey = true,
  altKey = true,
}: {
  key: string
  keyCode: number
  ctrlKey?: boolean
  altKey?: boolean
}): void => {
  document.dispatchEvent(new KeyboardEvent('keyup', {
    key,
    keyCode,
    which: keyCode,
    ctrlKey,
    altKey,
    bubbles: true,
    cancelable: true,
  }))
}

describe('date scrub keyboard gesture', () => {
  let unregisterHandler: (() => void) | null = null
  let unregisterKeyboard: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    hotkeys.unbind()
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
    hotkeys.unbind()
    document.body.innerHTML = ''
  })

  it('starts when ctrl and alt are both held and commits on modifier release', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Control',
      ctrlKey: true,
    }))
    expect(handler.start).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))
    expect(handler.update).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Alt',
      ctrlKey: true,
    }))

    expect(handler.end).toHaveBeenCalledWith(true)
  })

  it('maps up/down and h/k to one-day increments', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(2, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(0, false)
  })

  it('routes ctrl-alt letter chords when Alt changes event.key', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    dispatchHotkeyKeydown({key: '˙', keyCode: 72})
    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    dispatchHotkeyKeyup({key: '˙', keyCode: 72})

    dispatchHotkeyKeydown({key: '˚', keyCode: 75})
    expect(handler.update).toHaveBeenLastCalledWith(0, false)
    dispatchHotkeyKeyup({key: '˚', keyCode: 75})

    dispatchHotkeyKeydown({key: '¬', keyCode: 76})
    expect(handler.update).toHaveBeenLastCalledWith(7, false)
  })

  it('maps ctrl-alt-l when the browser reports the ctrl-l control key value', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '\f',
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(7, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Clear',
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(14, false)
  })

  it('maps left/right and j/l to one-week increments', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Control',
      ctrlKey: true,
      altKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(7, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(14, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(7, false)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      altKey: true,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(0, false)
  })

  it('cancels an active keyboard scrub on Escape', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))

    expect(handler.end).toHaveBeenCalledWith(false)
  })

  it('prevents default handling for scrub movement keys', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(preventDefault).toHaveBeenCalled()
  })

  it('updates an active keyboard scrub from ctrl-alt vertical wheel events', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('ignores horizontal wheel events during active keyboard scrub', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Alt',
      ctrlKey: true,
      altKey: true,
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 14,
      deltaY: 0,
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(handler.update).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
