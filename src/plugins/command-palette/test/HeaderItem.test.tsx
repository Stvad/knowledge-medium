// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandPaletteHeaderItem } from '../HeaderItem.tsx'
import { commandPaletteToggle } from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  commandPaletteToggle.close()
})

describe('CommandPaletteHeaderItem', () => {
  it('keeps the header affordance desktop-only while preserving activation', () => {
    render(<CommandPaletteHeaderItem/>)

    const button = screen.getByRole('button', {name: 'Command palette'})
    expect(button).toHaveClass('hidden', 'md:inline-flex')

    expect(commandPaletteToggle.isOpen()).toBe(false)
    fireEvent.click(button)
    expect(commandPaletteToggle.isOpen()).toBe(true)
  })
})
