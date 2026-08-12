// @vitest-environment happy-dom
/**
 * The picker's OPEN path — specifically, that it can't get stuck.
 *
 * Nothing renders until the movers' subtrees resolve, so a rejected load
 * leaves no dialog and no cancel control while `openDialog`'s promise
 * stays pending forever; retry and you accumulate more invisible queue
 * entries. The component must cancel instead.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const showErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showError: showErrorMock}))

const repoMock = vi.hoisted(() => ({current: {} as unknown}))
vi.mock('@/context/repo.js', () => ({useRepo: () => repoMock.current}))

import { MoveDestinationPicker } from './MoveDestinationPicker.tsx'

const repoWithSubtree = (load: () => Promise<unknown>) => ({
  query: {subtree: () => ({load})},
})

const renderPicker = async (repo: unknown, blockIds = ['a']) => {
  repoMock.current = repo
  const resolve = vi.fn()
  const cancel = vi.fn()
  await act(async () => {
    render(
      <MoveDestinationPicker
        blockIds={blockIds}
        workspaceId="ws-1"
        resolve={resolve}
        cancel={cancel}
      />,
    )
  })
  return {resolve, cancel}
}

afterEach(() => {
  cleanup()
  showErrorMock.mockClear()
})

describe('MoveDestinationPicker open path', () => {
  it('cancels (rather than hanging invisibly) when the subtree load rejects', async () => {
    const {resolve, cancel} = await renderPicker(
      repoWithSubtree(() => Promise.reject(new Error('db went away'))),
    )

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(showErrorMock).toHaveBeenCalledTimes(1)
  })

  it('cancels when asked to move nothing', async () => {
    const {cancel} = await renderPicker(repoWithSubtree(async () => []), [])

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('renders the picker once the subtrees resolve', async () => {
    // The positive control for the two negatives above: prove the same
    // setup DOES render when the load succeeds, so "cancel was called"
    // isn't just "the component never got anywhere".
    const {cancel} = await renderPicker(repoWithSubtree(async () => [{id: 'a-child'}]))

    expect(cancel).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Find destination…')).toBeTruthy()
  })
})
