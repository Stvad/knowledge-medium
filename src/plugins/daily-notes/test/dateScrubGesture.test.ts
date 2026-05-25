import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import {
  finishDateKeyboardScrub,
  installDateWheelScrubListeners,
  registerScrubHandler,
  startDateKeyboardScrub,
  type ScrubHandler,
  updateDateKeyboardScrubByDays,
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
  let unregisterWheel: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    setMobileViewport(false)
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregisterHandler = registerScrubHandler(handler)
    unregisterWheel = installDateWheelScrubListeners(() => ({
      block: {id: 'dated-block'} as Block,
    }))
  })

  afterEach(() => {
    unregisterWheel?.()
    unregisterWheel = null
    unregisterHandler?.()
    unregisterHandler = null
    finishDateKeyboardScrub(false)
    document.body.innerHTML = ''
  })

  it('starts explicit keyboard scrub sessions and runs onEnd after finish', () => {
    const onEnd = vi.fn()
    const started = startDateKeyboardScrub(
      {block: {id: 'dated-block'} as Block},
      {onEnd},
    )

    expect(started).toBe(true)
    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))
    expect(handler.update).not.toHaveBeenCalled()

    finishDateKeyboardScrub(true)

    expect(handler.end).toHaveBeenCalledWith(true)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('updates an explicit keyboard scrub by day deltas', () => {
    startDateKeyboardScrub({block: {id: 'dated-block'} as Block})

    expect(updateDateKeyboardScrubByDays(1)).toBe(true)
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    expect(updateDateKeyboardScrubByDays(7)).toBe(true)
    expect(handler.update).toHaveBeenLastCalledWith(8, false)
  })

  it('returns false when no explicit keyboard scrub is active', () => {
    expect(updateDateKeyboardScrubByDays(1)).toBe(false)
  })

  it('starts and updates wheel scrub from ctrl-shift vertical wheel events', () => {
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

    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('uses horizontal wheel delta when shift remaps vertical wheel motion', () => {
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

  it('commits wheel scrub on modifier release', () => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaMode: 0,
      deltaY: -14,
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    }))

    const event = new KeyboardEvent('keyup', {
      key: 'Shift',
      ctrlKey: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    window.dispatchEvent(event)

    expect(handler.end).toHaveBeenCalledWith(true)
    expect(preventDefault).toHaveBeenCalled()
  })
})
