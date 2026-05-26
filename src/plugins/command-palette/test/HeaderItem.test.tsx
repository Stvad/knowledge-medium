import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPaletteHeaderItem } from '../HeaderItem.tsx'
import { toggleCommandPaletteEvent } from '../events.ts'

afterEach(() => {
  cleanup()
})

describe('CommandPaletteHeaderItem', () => {
  it('keeps the header affordance desktop-only while preserving activation', () => {
    const listener = vi.fn()
    window.addEventListener(toggleCommandPaletteEvent, listener)

    try {
      render(<CommandPaletteHeaderItem/>)

      const button = screen.getByRole('button', {name: 'Command palette'})
      expect(button).toHaveClass('hidden', 'md:inline-flex')

      fireEvent.click(button)
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(toggleCommandPaletteEvent, listener)
    }
  })
})
