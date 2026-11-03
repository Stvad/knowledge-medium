// @vitest-environment happy-dom

import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ActionConfig} from '@/shortcuts/types.js'

const h = vi.hoisted(() => {
  const contextConfig = {
    type: 'global',
    displayName: 'Global',
    validateDependencies: (deps: unknown): deps is object => deps !== undefined,
  }
  const action = {
    id: 'test.inspectable',
    description: 'Inspect this action',
    context: 'global' as const,
    handler: () => undefined,
    defaultBinding: {keys: '$mod+k'},
  }
  return {
    contextConfig,
    action,
    actions: [action] as ActionConfig[],
    active: new Map([['global', {}]]),
    contextConfigsByType: new Map([['global', contextConfig]]),
    runtime: {onFacetChange: () => () => undefined, read: () => [], contributionsById: () => []},
  }
})

vi.mock('@/context/repo.js', () => ({useRepo: () => ({})}))
vi.mock('@/components/useEditModeYieldKeepalive.js', () => ({useEditModeYieldKeepalive: () => undefined}))
vi.mock('@/shortcuts/useActionDiscovery.js', () => ({
  useActionDiscovery: () => ({
    runtime: h.runtime,
    active: h.active,
    actions: h.actions,
    contextConfigsByType: h.contextConfigsByType,
  }),
}))

import {formatLinkClickGesture, linkClickActions, nativeLinkClickGesture} from '@/utils/linkClickGestures.js'
import {INSERT_TUTORIAL_ACTION_ID} from '@/plugins/onboarding/action.ts'
import {setRunActionDispatcher} from '@/shortcuts/runAction.js'
import {ShortcutHelpOverlay} from '../ShortcutHelpOverlay.tsx'
import {shortcutHelpToggle} from '../toggleStore.ts'

beforeEach(() => {
  h.actions.splice(0, h.actions.length, h.action)
})

afterEach(() => {
  cleanup()
  shortcutHelpToggle.close()
  setRunActionDispatcher(null)
  vi.restoreAllMocks()
})

describe('ShortcutHelpOverlay', () => {
  it.each(['click', 'Enter'])('opens the tutorial through its action with %s after closing help', async activation => {
    h.actions.push({
      id: INSERT_TUTORIAL_ACTION_ID,
      description: 'Open tutorial',
      context: 'global',
      handler: () => undefined,
    })
    const dispatch = vi.fn(() => {
      expect(shortcutHelpToggle.isOpen()).toBe(false)
    })
    setRunActionDispatcher(dispatch)
    render(<ShortcutHelpOverlay/>)
    act(() => shortcutHelpToggle.open())

    const button = await screen.findByRole('button', {name: 'Open tutorial'})
    if (activation === 'click') fireEvent.click(button)
    else {
      button.focus()
      fireEvent.keyDown(button, {key: 'Enter'})
    }

    expect(dispatch).toHaveBeenCalledWith(INSERT_TUTORIAL_ACTION_ID, expect.any(CustomEvent))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('omits the tutorial entry when its plugin is unavailable', () => {
    render(<ShortcutHelpOverlay/>)
    act(() => shortcutHelpToggle.open())

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('button', {name: 'Open tutorial'})).toBeNull()
  })

  it('shows shared link gestures when opened and still inspects keyboard bindings', async () => {
    render(<ShortcutHelpOverlay/>)
    act(() => shortcutHelpToggle.open())

    expect(await screen.findByRole('heading', {name: 'Shortcuts & gestures'})).toBeTruthy()
    const section = screen.getByRole('region', {name: 'Link click gestures'})
    expect(section.textContent).toContain('For page links and block references.')
    expect(section.textContent).toContain('Shift-clicking ordinary block text selects blocks.')
    expect(screen.getByText('Click')).toBeTruthy()
    expect(screen.getByText('Open in current panel')).toBeTruthy()
    for (const action of linkClickActions) {
      expect(section.textContent).toContain(formatLinkClickGesture(action.modifiers))
      expect(section.textContent).toContain(action.label)
    }
    expect(section.textContent).toContain(nativeLinkClickGesture())
    expect(screen.getByText('Open in new browser tab')).toBeTruthy()

    fireEvent.keyDown(window, {key: 'k', ctrlKey: true})
    expect(await screen.findByText('test.inspectable')).toBeTruthy()
  })
})
