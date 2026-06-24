import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateScrubRevealAction, dateScrubCommitAction } from '../dateScrubGestureActions.ts'
import {
  registerScrubHandler,
  dateScrubProgressTickEvent,
  type ScrubHandler,
} from '../dateScrubGesture.ts'
import { gestureProgressCancelEvent } from '@/shortcuts/gestureAction.js'
import type { Block } from '@/data/block'
import type { ActionTrigger, BlockPointerDependencies } from '@/shortcuts/types.js'

const deps = {block: {id: 'b1'} as Block} as unknown as BlockPointerDependencies
const fire = (action: typeof dateScrubRevealAction, trigger: ActionTrigger): void => {
  action.handler(deps, trigger, undefined as never)
}

let handler: ScrubHandler
let unregister: (() => void) | null = null

beforeEach(() => {
  handler = {start: vi.fn(() => true), update: vi.fn(), end: vi.fn()}
  unregister = registerScrubHandler(handler)
})
afterEach(() => {
  unregister?.()
  unregister = null
})

describe('date-scrub gesture actions', () => {
  it('opens the overlay at the anchor on the first (begin) tick, then updates', () => {
    fire(dateScrubRevealAction, dateScrubProgressTickEvent({deltaDays: 2, cancelIntent: false, begin: {startX: 10, startY: 20}}))
    expect(handler.start).toHaveBeenCalledWith(
      expect.objectContaining({blockId: 'b1', startX: 10, startY: 20}),
    )
    expect(handler.update).toHaveBeenCalledWith(2, false)
  })

  it('streams later ticks as updates without re-opening the overlay', () => {
    fire(dateScrubRevealAction, dateScrubProgressTickEvent({deltaDays: 3, cancelIntent: true}))
    expect(handler.start).not.toHaveBeenCalled()
    expect(handler.update).toHaveBeenCalledWith(3, true)
  })

  it('reverts the preview on the terminal settle (cancel) event', () => {
    fire(dateScrubRevealAction, gestureProgressCancelEvent('date-scrub'))
    expect(handler.end).toHaveBeenCalledWith(false)
    expect(handler.update).not.toHaveBeenCalled()
  })

  it('writes the date on the commit action', () => {
    fire(dateScrubCommitAction, gestureProgressCancelEvent('ignored'))
    expect(handler.end).toHaveBeenCalledWith(true)
  })
})
