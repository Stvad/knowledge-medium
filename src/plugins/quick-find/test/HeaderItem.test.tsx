import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuickFindHeaderItem } from '../HeaderItem.tsx'
import { quickFindToggle } from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  quickFindToggle.close()
})

describe('QuickFindHeaderItem', () => {
  it('keeps the header affordance desktop-only while preserving activation', () => {
    render(<QuickFindHeaderItem/>)

    const button = screen.getByRole('button', {name: 'Find or create page or block'})
    expect(button).toHaveClass('hidden', 'md:inline-flex')

    expect(quickFindToggle.isOpen()).toBe(false)
    fireEvent.click(button)
    expect(quickFindToggle.isOpen()).toBe(true)
  })
})
