import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WheelEvent } from 'react'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { PropertySchema } from '@/data/api'
import {
  blockContentSurfacePropsFacet,
  type BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  dateWheelScrubContentSurface,
  registerScrubHandler,
  type ScrubHandler,
} from '../dateScrubGesture.ts'

const makeFakeUiStateBlock = (): Block => {
  const props = new Map<string, unknown>()
  return {
    peekProperty: vi.fn((schema: PropertySchema<unknown>) => props.get(schema.name)),
    set: vi.fn(async (schema: PropertySchema<unknown>, value: unknown) => {
      if (value === undefined) props.delete(schema.name)
      else props.set(schema.name, value)
    }),
  } as unknown as Block
}

const makeContext = (id = 'block-1', uiStateBlock = makeFakeUiStateBlock()): BlockInteractionContext => ({
  block: {id} as Block,
  repo: {} as Repo,
  uiStateBlock,
  types: [],
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
})

const runtime = () => resolveFacetRuntimeSync([
  blockContentSurfacePropsFacet.of(dateWheelScrubContentSurface),
])

const handlers = (context = makeContext()) =>
  runtime().read(blockContentSurfacePropsFacet)(context)

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

const wheelEvent = ({
  deltaX,
  deltaY = 0,
  altKey = true,
  target = document.createElement('div'),
  currentTarget = target,
}: {
  deltaX: number
  deltaY?: number
  altKey?: boolean
  target?: EventTarget
  currentTarget?: EventTarget
}): WheelEvent<HTMLDivElement> => ({
  altKey,
  clientX: 120,
  clientY: 80,
  currentTarget,
  deltaMode: 0,
  deltaX,
  deltaY,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  target,
} as unknown as WheelEvent<HTMLDivElement>)

describe('date scrub wheel gesture', () => {
  let unregister: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    vi.useFakeTimers()
    setMobileViewport(false)
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregister = registerScrubHandler(handler)
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('starts, updates, and commits an option-horizontal wheel scrub on Alt release', () => {
    const props = handlers(makeContext('dated-block'))

    const belowLock = wheelEvent({deltaX: 6})
    props.onWheel?.(belowLock)
    expect(handler.start).not.toHaveBeenCalled()
    expect(belowLock.preventDefault).not.toHaveBeenCalled()

    const locked = wheelEvent({deltaX: 8})
    props.onWheel?.(locked)

    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
      startX: 120,
      startY: 80,
    }))
    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(locked.preventDefault).toHaveBeenCalled()

    vi.advanceTimersByTime(260)
    expect(handler.end).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keyup', {key: 'Alt'}))
    expect(handler.end).toHaveBeenCalledWith(true)
  })

  it('continues updating an active wheel scrub while Alt remains down after an idle gap', () => {
    const props = handlers(makeContext('dated-block'))

    props.onWheel?.(wheelEvent({deltaX: 14}))
    vi.advanceTimersByTime(1000)
    expect(handler.end).not.toHaveBeenCalled()

    props.onWheel?.(wheelEvent({deltaX: 14}))

    expect(handler.update).toHaveBeenLastCalledWith(2, false)
    expect(handler.end).not.toHaveBeenCalled()
  })

  it('cancels an active wheel scrub on Escape', () => {
    const props = handlers(makeContext('dated-block'))

    props.onWheel?.(wheelEvent({deltaX: 14}))
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))

    expect(handler.end).toHaveBeenCalledWith(false)
  })

  it('ignores horizontal wheel events without the Option key', () => {
    const props = handlers(makeContext('dated-block'))
    const event = wheelEvent({deltaX: 40, altKey: false})

    props.onWheel?.(event)

    expect(handler.start).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores predominantly vertical wheel events', () => {
    const props = handlers(makeContext('dated-block'))
    const event = wheelEvent({deltaX: 12, deltaY: 40})

    props.onWheel?.(event)

    expect(handler.start).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not run on mobile viewports', () => {
    setMobileViewport(true)
    const props = handlers(makeContext('dated-block'))
    const event = wheelEvent({deltaX: 40})

    props.onWheel?.(event)

    expect(handler.start).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('keeps interactive controls out of the wheel gesture', () => {
    const props = handlers(makeContext('dated-block'))
    const button = document.createElement('button')
    const event = wheelEvent({deltaX: 40, target: button})

    props.onWheel?.(event)

    expect(handler.start).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
