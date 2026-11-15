// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest'
import {focusPickedPlaceholder} from './outlinePlaceholderNavigation'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

it('disconnects the pick observer when the placeholder never mounts', () => {
  vi.useFakeTimers()
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
  focusPickedPlaceholder('missing', 'outline', () => true)
  expect(disconnect).not.toHaveBeenCalled()
  vi.advanceTimersByTime(5000)
  expect(disconnect).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the deadline when a picked placeholder mounts', async () => {
  vi.useFakeTimers()
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
  focusPickedPlaceholder('field', 'outline', () => true)
  const target = document.createElement('div')
  target.tabIndex = -1
  target.dataset.propertyPlaceholder = 'field'
  target.dataset.outlinePlaceholderScope = 'outline'
  target.getBoundingClientRect = () => ({width: 10, height: 10}) as DOMRect
  document.body.append(target)
  await vi.waitFor(() => expect(document.activeElement).toBe(target))
  expect(disconnect).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
