// @vitest-environment happy-dom

import {act, cleanup, render, screen} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {DialogHost} from '@/extensions/dialogAppMount'
import {__resetDialogsForTests, openDialog} from '@/utils/dialogs'

vi.mock('@/shortcuts/useActionContext.js', () => ({
  useModalShadowing: vi.fn(),
}))

const ThrowingDialog = () => {
  throw new Error('dialog render failed')
}

const WorkingDialog = ({resolve}: {resolve: (value: string) => void}) => (
  <button onClick={() => resolve('finished')}>Finish dialog</button>
)

afterEach(() => {
  cleanup()
  __resetDialogsForTests()
  vi.restoreAllMocks()
})

describe('DialogHost', () => {
  it('cancels a dialog that throws while rendering and keeps hosting later dialogs', async () => {
    const error = new Error('dialog render failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = openDialog(ThrowingDialog)
    render(<DialogHost />)

    await expect(first).resolves.toBeNull()
    expect(consoleError).toHaveBeenCalledWith('[dialogs] dialog render failed', error)

    let second!: Promise<string | null>
    act(() => {
      second = openDialog(WorkingDialog)
    })

    expect(await screen.findByRole('button', {name: 'Finish dialog'})).toBeTruthy()
    await act(async () => {
      screen.getByRole('button', {name: 'Finish dialog'}).click()
    })
    await expect(second).resolves.toBe('finished')
  })
})
