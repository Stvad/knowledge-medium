import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BaseShortcutDependencies } from '@/shortcuts/types.js'
import {
  DATE_SCRUB_BACKWARD_DAY_ACTION_ID,
  DATE_SCRUB_BACKWARD_WEEK_ACTION_ID,
  DATE_SCRUB_CANCEL_ACTION_ID,
  DATE_SCRUB_COMMIT_ACTION_ID,
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_FORWARD_DAY_ACTION_ID,
  DATE_SCRUB_FORWARD_WEEK_ACTION_ID,
  EDIT_MODE_START_DATE_SCRUB_ACTION_ID,
  START_DATE_SCRUB_ACTION_ID,
  dateScrubActionContext,
  dateScrubModeActions,
  dateScrubStartActions,
} from '../dateScrubActions.ts'
import {
  finishDateKeyboardScrub,
  registerDateKeyboardScrubStartHandler,
  registerScrubHandler,
  startDateKeyboardScrub,
  type ScrubHandler,
} from '../dateScrubGesture.ts'

const deps = {} as BaseShortcutDependencies
const trigger = {} as KeyboardEvent

const findModeAction = (id: string) => {
  const action = dateScrubModeActions.find(candidate => candidate.id === id)
  if (!action) throw new Error(`Missing action ${id}`)
  return action
}

describe('date scrub actions', () => {
  it('declares an exclusive date scrub context', () => {
    expect(dateScrubActionContext).toMatchObject({
      type: DATE_SCRUB_CONTEXT,
      exclusive: true,
    })
  })

  it('requests scrub-mode activation from normal and edit-mode start actions', async () => {
    const requested = vi.fn()
    const unregister = registerDateKeyboardScrubStartHandler(requested)
    try {
      for (const actionId of [START_DATE_SCRUB_ACTION_ID, EDIT_MODE_START_DATE_SCRUB_ACTION_ID]) {
        const action = dateScrubStartActions.find(candidate => candidate.id === actionId)
        expect(action?.defaultBinding?.keys).toBe('ctrl+shift+d')
        await action?.handler(deps, trigger)
      }
    } finally {
      unregister()
    }

    expect(requested).toHaveBeenCalledTimes(2)
  })

  it('maps movement actions onto explicit scrub deltas', async () => {
    const handler: ScrubHandler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    const unregister = registerScrubHandler(handler)
    try {
      startDateKeyboardScrub({block: {id: 'dated-block'} as Block})

      await findModeAction(DATE_SCRUB_FORWARD_DAY_ACTION_ID).handler(deps, trigger)
      expect(handler.update).toHaveBeenLastCalledWith(1, false)

      await findModeAction(DATE_SCRUB_BACKWARD_DAY_ACTION_ID).handler(deps, trigger)
      expect(handler.update).toHaveBeenLastCalledWith(0, false)

      await findModeAction(DATE_SCRUB_FORWARD_WEEK_ACTION_ID).handler(deps, trigger)
      expect(handler.update).toHaveBeenLastCalledWith(7, false)

      await findModeAction(DATE_SCRUB_BACKWARD_WEEK_ACTION_ID).handler(deps, trigger)
      expect(handler.update).toHaveBeenLastCalledWith(0, false)
    } finally {
      finishDateKeyboardScrub(false)
      unregister()
    }
  })

  it('commits and cancels via scrub mode actions', async () => {
    const handler: ScrubHandler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    const unregister = registerScrubHandler(handler)
    try {
      startDateKeyboardScrub({block: {id: 'dated-block'} as Block})
      await findModeAction(DATE_SCRUB_COMMIT_ACTION_ID).handler(deps, trigger)
      expect(handler.end).toHaveBeenLastCalledWith(true)

      startDateKeyboardScrub({block: {id: 'dated-block'} as Block})
      await findModeAction(DATE_SCRUB_CANCEL_ACTION_ID).handler(deps, trigger)
      expect(handler.end).toHaveBeenLastCalledWith(false)
    } finally {
      finishDateKeyboardScrub(false)
      unregister()
    }
  })
})
