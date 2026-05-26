import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuickFindHeaderItem } from '../HeaderItem.tsx'
import { toggleQuickFindEvent } from '../events.ts'

afterEach(() => {
  cleanup()
})

describe('QuickFindHeaderItem', () => {
  it('keeps the header affordance desktop-only while preserving activation', () => {
    const listener = vi.fn()
    window.addEventListener(toggleQuickFindEvent, listener)

    try {
      render(<QuickFindHeaderItem/>)

      const button = screen.getByRole('button', {name: 'Find or create page or block'})
      expect(button).toHaveClass('hidden', 'md:inline-flex')

      fireEvent.click(button)
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(toggleQuickFindEvent, listener)
    }
  })
})
