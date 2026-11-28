// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { actionsFacet } from '@/extensions/core.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
} from '@/shortcuts/keybindingOverrides.js'
import { quickFindAction } from '../index.ts'
import { QuickFindHeaderItem } from '../HeaderItem.tsx'
import { quickFindToggle } from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  quickFindToggle.close()
})

describe('QuickFindHeaderItem', () => {
  const runtime = () => resolveFacetRuntimeSync(actionsFacet.of(quickFindAction, {source: 'test'}))

  it('keeps the header affordance desktop-only while preserving activation', () => {
    render(<AppRuntimeContextProvider value={runtime()}><QuickFindHeaderItem/></AppRuntimeContextProvider>)

    const button = screen.getByRole('button', {name: 'Find or create page or block'})
    expect(button).toHaveClass('hidden', 'md:inline-flex')

    expect(quickFindToggle.isOpen()).toBe(false)
    fireEvent.click(button)
    expect(quickFindToggle.isOpen()).toBe(true)
  })

  it('updates its badge and title from a live remap, then removes both when unbound', () => {
    const appRuntime = runtime()
    render(
      <AppRuntimeContextProvider value={appRuntime}>
        <QuickFindHeaderItem/>
      </AppRuntimeContextProvider>,
    )

    const button = screen.getByRole('button', {name: 'Find or create page or block'})
    expect(button).toHaveAttribute('title', 'Find or create page or block (Ctrl+P)')
    expect(button.querySelector('kbd')).toHaveTextContent('Ctrl+P')

    act(() => {
      appRuntime.setRuntimeContributions(keybindingOverridesFacet, KEYBINDING_OVERRIDE_USER_SOURCE, [{
        actionId: quickFindAction.id,
        binding: {keys: 'KeyR'},
        source: KEYBINDING_OVERRIDE_USER_SOURCE,
      }])
    })
    expect(button).toHaveAttribute('title', 'Find or create page or block (R)')
    expect(button.querySelector('kbd')).toHaveTextContent('R')

    act(() => {
      appRuntime.setRuntimeContributions(keybindingOverridesFacet, KEYBINDING_OVERRIDE_USER_SOURCE, [{
        actionId: quickFindAction.id,
        binding: {unbound: true},
        source: KEYBINDING_OVERRIDE_USER_SOURCE,
      }])
    })
    expect(button).toHaveAttribute('title', 'Find or create page or block')
    expect(button.querySelector('kbd')).toBeNull()
  })
})
