// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmBulkDeleteDialog } from '@/components/ConfirmBulkDeleteDialog'

const renderDialog = (targetCount: number, totalCount: number) => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(
    <ConfirmBulkDeleteDialog
      targetCount={targetCount}
      totalCount={totalCount}
      resolve={resolve}
      cancel={cancel}
    />,
  )
  return {resolve, cancel}
}

/** The dialog's whole job is telling the user what the delete costs, and the
 *  sentence is assembled from two counts that can each be 1. Read it back as
 *  the user would rather than asserting on the parts. */
describe('ConfirmBulkDeleteDialog', () => {
  it('names the nested blocks a single target drags with it', () => {
    renderDialog(1, 24)
    expect(screen.getByRole('heading').textContent).toBe('Delete 24 blocks?')
    expect(screen.getByText(/will be deleted/).textContent)
      .toBe('This block and the 23 blocks nested under it will be deleted.')
  })

  it('splits selection from nesting for a multi-block gesture', () => {
    renderDialog(4, 30)
    expect(screen.getByText(/will be deleted/).textContent)
      .toBe('4 selected blocks and the 26 blocks nested under them will be deleted.')
  })

  it('drops the nesting clause when there is none', () => {
    renderDialog(12, 12)
    expect(screen.getByText(/will be deleted/).textContent)
      .toBe('12 selected blocks will be deleted.')
  })
})
