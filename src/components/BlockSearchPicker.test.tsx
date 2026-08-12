// @vitest-environment happy-dom

import { type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockSearchPicker } from './BlockSearchPicker.tsx'

const mocks = vi.hoisted(() => ({
  searchLinkTargets: vi.fn(),
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({}),
}))

vi.mock('@/utils/linkTargetAutocomplete.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  searchLinkTargets: mocks.searchLinkTargets,
}))

const renderPicker = (props: Partial<ComponentProps<typeof BlockSearchPicker>> = {}) => {
  const onSelect = vi.fn()
  const onCancel = vi.fn()
  render(
    <BlockSearchPicker
      title="Pick a block"
      description="Pick a destination."
      placeholder="Find…"
      workspaceId="ws-1"
      excludeBlockIds={[]}
      onSelect={onSelect}
      onCancel={onCancel}
      {...props}
    />,
  )
  return {onSelect, onCancel}
}

const search = async (query: string) => {
  fireEvent.change(screen.getByPlaceholderText('Find…'), {target: {value: query}})
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
}

describe('BlockSearchPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.searchLinkTargets.mockReset()
    mocks.searchLinkTargets.mockResolvedValue({
      aliases: [{blockId: 'page-1', alias: 'Project Alpha', content: 'Project Alpha'}],
      blocks: [{blockId: 'block-1', content: 'Sync notes', label: 'Sync notes'}],
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders alias matches under Pages and content matches under Blocks', async () => {
    renderPicker()

    await search('proj')

    expect(screen.getByText('Pages')).toBeInTheDocument()
    expect(screen.getByRole('option', {name: 'Project Alpha'})).toBeInTheDocument()
    expect(screen.getByText('Blocks')).toBeInTheDocument()
    expect(screen.getByRole('option', {name: 'Sync notes'})).toBeInTheDocument()
  })

  it('suppresses the Blocks group when showBlocks is false while Pages still renders', async () => {
    renderPicker({showBlocks: false})

    await search('proj')

    expect(screen.getByText('Pages')).toBeInTheDocument()
    expect(screen.getByRole('option', {name: 'Project Alpha'})).toBeInTheDocument()
    expect(screen.queryByText('Blocks')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', {name: 'Sync notes'})).not.toBeInTheDocument()
  })

  it('says the search FAILED rather than showing the same empty-state as no matches', async () => {
    // `searchLinkTargets` rejects when the alias query fails or when every
    // registered content source does. Left unhandled it was both an
    // unhandled rejection and a lie: "No results." is what the user sees
    // for an empty workspace, so a broken search reads as an empty one.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.searchLinkTargets.mockRejectedValue(new Error('every source failed'))
    renderPicker()

    await search('proj')

    expect(screen.getByText(/Search failed/)).toBeInTheDocument()
    expect(screen.queryByText('No results.')).not.toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('recovers on the next query after a failed search', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.searchLinkTargets.mockRejectedValueOnce(new Error('transient'))
    renderPicker()

    await search('proj')
    expect(screen.getByText(/Search failed/)).toBeInTheDocument()

    await search('project')

    expect(screen.queryByText(/Search failed/)).not.toBeInTheDocument()
    expect(screen.getByRole('option', {name: 'Project Alpha'})).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('calls onSelect with the picked block id', async () => {
    const {onSelect} = renderPicker()

    await search('proj')
    fireEvent.click(screen.getByRole('option', {name: 'Sync notes'}))

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('block-1')

    fireEvent.click(screen.getByRole('option', {name: 'Project Alpha'}))
    expect(onSelect).toHaveBeenLastCalledWith('page-1')
  })
})
