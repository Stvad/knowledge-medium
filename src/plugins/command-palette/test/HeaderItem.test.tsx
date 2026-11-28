// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { actionsFacet } from '@/extensions/core.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { commandPaletteAction } from '../index.ts'
import { CommandPaletteHeaderItem } from '../HeaderItem.tsx'
import { commandPaletteToggle } from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  commandPaletteToggle.close()
})

describe('CommandPaletteHeaderItem', () => {
  it('keeps the header affordance desktop-only while preserving activation', () => {
    const runtime = resolveFacetRuntimeSync(actionsFacet.of(commandPaletteAction, {source: 'test'}))
    render(<AppRuntimeContextProvider value={runtime}><CommandPaletteHeaderItem/></AppRuntimeContextProvider>)

    const button = screen.getByRole('button', {name: 'Command palette'})
    expect(button).toHaveClass('hidden', 'md:inline-flex')

    expect(commandPaletteToggle.isOpen()).toBe(false)
    fireEvent.click(button)
    expect(commandPaletteToggle.isOpen()).toBe(true)
  })
})
