// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { buildShortcutHelpModel } from '../model.ts'
import { useKeyInspector } from '../useKeyInspector.ts'

const globalConfig: ActionContextConfig = {
  type: ActionContextTypes.GLOBAL,
  displayName: 'Global',
  validateDependencies: (deps: unknown): deps is BaseShortcutDependencies => deps !== undefined,
}

const action = (id: string, keys: string | string[]): ActionConfig => ({
  id,
  description: `run ${id}`,
  context: ActionContextTypes.GLOBAL as ActionContextType,
  handler: () => undefined,
  defaultBinding: {keys},
})

const active: ActiveContextsMap = new Map([
  [ActionContextTypes.GLOBAL, {uiStateBlock: {} as never}],
])

const model = buildShortcutHelpModel(
  [action('palette', '$mod+k'), action('top', 'g g')],
  {active, contextConfigsByType: new Map([[globalConfig.type, globalConfig]])},
)

const press = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
  window.dispatchEvent(event)
  return event
}

describe('useKeyInspector', () => {
  it('swallows captured keydowns before window bubble listeners (the coordinator path)', () => {
    const bubbleListener = vi.fn()
    window.addEventListener('keydown', bubbleListener)
    const {unmount} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))

    let event!: KeyboardEvent
    act(() => {
      event = press({key: 'k', metaKey: true})
    })
    expect(bubbleListener).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    unmount()
    act(() => {
      press({key: 'k', metaKey: true})
    })
    expect(bubbleListener).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', bubbleListener)
  })

  it('resolves an exact chord to its matches', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      // jsdom's platform has no Mac marker, so Ctrl is the $mod primary here.
      press({key: 'k', ctrlKey: true})
    })
    expect(result.current.state.matches?.map(b => b.action.id)).toEqual(['palette'])
    expect(result.current.state.pendingMatches).toBeNull()
    expect(result.current.state.pressed).toEqual([])
  })

  it('keeps a sequence prefix pending, then completes it', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.pressed).toEqual(['g'])
    expect(result.current.state.pendingMatches?.map(b => b.action.id)).toEqual(['top'])
    expect(result.current.state.matches).toBeNull()

    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.matches?.map(b => b.action.id)).toEqual(['top'])
    expect(result.current.state.pressed).toEqual([])
    expect(result.current.state.pendingMatches).toBeNull()
  })

  it('flags an unbound chord and clears the buffer', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      press({key: 'q'})
    })
    expect(result.current.state.unmatched).toEqual(['q'])
    expect(result.current.state.pressed).toEqual([])
  })

  it('Escape clears inspector state first, then closes', () => {
    const onClose = vi.fn()
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, onClose))
    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.pressed).toEqual(['g'])

    act(() => {
      press({key: 'Escape'})
    })
    expect(result.current.state.pressed).toEqual([])
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      press({key: 'Escape'})
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not listen while closed', () => {
    const {result} = renderHook(() => useKeyInspector(false, model.bindings, vi.fn()))
    let event!: KeyboardEvent
    act(() => {
      event = press({key: 'g'})
    })
    expect(result.current.state.pressed).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})
