// @vitest-environment happy-dom

import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'

const h = vi.hoisted(() => {
  const contextConfig = {
    type: 'global',
    displayName: 'Global',
    validateDependencies: (deps: unknown): deps is object => deps !== undefined,
  }
  const action = {
    id: 'test.inspectable',
    description: 'Inspect this action',
    context: 'global',
    handler: () => undefined,
    defaultBinding: {keys: '$mod+k'},
  }
  return {
    contextConfig,
    action,
    actions: [action],
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
import {ShortcutHelpOverlay} from '../ShortcutHelpOverlay.tsx'
import {shortcutHelpToggle} from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  shortcutHelpToggle.close()
  vi.restoreAllMocks()
})

describe('ShortcutHelpOverlay', () => {
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
