import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionDispatch,
  type BaseShortcutDependencies,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import {
  endKeyboardScrub,
  registerScrubHandler,
  type ScrubHandler,
} from '../dateScrubGesture.ts'
import {
  DATE_SCRUB_CANCEL_ACTION_ID,
  DATE_SCRUB_COMMIT_ACTION_ID,
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_DAY_BACKWARD_ACTION_ID,
  DATE_SCRUB_DAY_FORWARD_ACTION_ID,
  DATE_SCRUB_WEEK_BACKWARD_ACTION_ID,
  DATE_SCRUB_WEEK_FORWARD_ACTION_ID,
  ENTER_DATE_SCRUB_ACTION_ID,
  dateScrubActionContext,
  dateScrubActions,
} from '../dateScrubActions.ts'

const fakeBlock = (id: string): Block => ({id} as Block)

const findAction = (id: string): ActionConfig => {
  const action = dateScrubActions.find(a => a.id === id)
  if (!action) throw new Error(`action ${id} missing`)
  return action
}

const fakeDispatch = (): ActionDispatch => ({
  activate: vi.fn() as ActionDispatch['activate'],
  deactivate: vi.fn() as ActionDispatch['deactivate'],
})

const fakeEvent = (): KeyboardEvent => new KeyboardEvent('keydown', {key: 's'})

describe('dateScrubActions', () => {
  let unregisterHandler: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregisterHandler = registerScrubHandler(handler)
  })

  afterEach(() => {
    // Module-level scrub state leaks across tests; clear it explicitly.
    endKeyboardScrub(false)
    unregisterHandler?.()
    unregisterHandler = null
  })

  it('declares a modal context', () => {
    expect(dateScrubActionContext.type).toBe(DATE_SCRUB_CONTEXT)
    expect(dateScrubActionContext.modal).toBe(true)
  })

  it('enter action: hold-s in NORMAL_MODE starts scrub and activates the modal context', () => {
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    expect(enter.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(enter.defaultBinding).toEqual(expect.objectContaining({
      keys: 's',
      phase: 'hold',
    }))

    const dispatch = fakeDispatch()
    const block = fakeBlock('b-1')
    const uiStateBlock = fakeBlock('ui-1')
    const deps: BlockShortcutDependencies = {block, uiStateBlock}

    enter.handler(deps, fakeEvent(), dispatch)

    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'b-1',
    }))
    expect(dispatch.activate).toHaveBeenCalledWith(
      DATE_SCRUB_CONTEXT,
      {uiStateBlock},
    )
  })

  it('enter action: does not activate the context when the overlay refuses', () => {
    handler.start = vi.fn(() => false)
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    const dispatch = fakeDispatch()

    enter.handler(
      {block: fakeBlock('b-1'), uiStateBlock: fakeBlock('ui-1')},
      fakeEvent(),
      dispatch,
    )

    expect(dispatch.activate).not.toHaveBeenCalled()
  })

  it.each([
    [DATE_SCRUB_DAY_FORWARD_ACTION_ID, 1, ['ArrowUp', 'h']],
    [DATE_SCRUB_DAY_BACKWARD_ACTION_ID, -1, ['ArrowDown', 'k']],
    [DATE_SCRUB_WEEK_FORWARD_ACTION_ID, 7, ['ArrowRight', 'l']],
    [DATE_SCRUB_WEEK_BACKWARD_ACTION_ID, -7, ['ArrowLeft', 'j']],
  ] as const)('movement action %s applies %i days via update', (id, delta, expectedKeys) => {
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    enter.handler(
      {block: fakeBlock('b-1'), uiStateBlock: fakeBlock('ui-1')},
      fakeEvent(),
      fakeDispatch(),
    )

    const action = findAction(id)
    expect(action.context).toBe(DATE_SCRUB_CONTEXT)
    expect(action.defaultBinding?.keys).toEqual(expectedKeys)

    const deps: BaseShortcutDependencies = {uiStateBlock: fakeBlock('ui-1')}
    action.handler(deps, fakeEvent(), fakeDispatch())

    expect(handler.update).toHaveBeenLastCalledWith(delta, false)
  })

  it('movement actions accumulate deltas into the running scrub', () => {
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    enter.handler(
      {block: fakeBlock('b-1'), uiStateBlock: fakeBlock('ui-1')},
      fakeEvent(),
      fakeDispatch(),
    )

    const day = findAction(DATE_SCRUB_DAY_FORWARD_ACTION_ID)
    const week = findAction(DATE_SCRUB_WEEK_FORWARD_ACTION_ID)
    const deps: BaseShortcutDependencies = {uiStateBlock: fakeBlock('ui-1')}

    day.handler(deps, fakeEvent(), fakeDispatch())
    expect(handler.update).toHaveBeenLastCalledWith(1, false)

    week.handler(deps, fakeEvent(), fakeDispatch())
    expect(handler.update).toHaveBeenLastCalledWith(8, false)

    day.handler(deps, fakeEvent(), fakeDispatch())
    expect(handler.update).toHaveBeenLastCalledWith(9, false)
  })

  it('commit action: ends with commit=true and deactivates the context', () => {
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    enter.handler(
      {block: fakeBlock('b-1'), uiStateBlock: fakeBlock('ui-1')},
      fakeEvent(),
      fakeDispatch(),
    )

    const commit = findAction(DATE_SCRUB_COMMIT_ACTION_ID)
    expect(commit.context).toBe(DATE_SCRUB_CONTEXT)
    expect(commit.defaultBinding).toEqual({keys: 's', phase: 'keyup'})

    const dispatch = fakeDispatch()
    commit.handler({uiStateBlock: fakeBlock('ui-1')}, fakeEvent(), dispatch)

    expect(handler.end).toHaveBeenCalledWith(true)
    expect(dispatch.deactivate).toHaveBeenCalledWith(DATE_SCRUB_CONTEXT)
  })

  it('cancel action: ends with commit=false and deactivates the context', () => {
    const enter = findAction(ENTER_DATE_SCRUB_ACTION_ID)
    enter.handler(
      {block: fakeBlock('b-1'), uiStateBlock: fakeBlock('ui-1')},
      fakeEvent(),
      fakeDispatch(),
    )

    const cancel = findAction(DATE_SCRUB_CANCEL_ACTION_ID)
    expect(cancel.context).toBe(DATE_SCRUB_CONTEXT)
    expect(cancel.defaultBinding).toEqual({keys: 'Escape'})

    const dispatch = fakeDispatch()
    cancel.handler({uiStateBlock: fakeBlock('ui-1')}, fakeEvent(), dispatch)

    expect(handler.end).toHaveBeenCalledWith(false)
    expect(dispatch.deactivate).toHaveBeenCalledWith(DATE_SCRUB_CONTEXT)
  })
})
