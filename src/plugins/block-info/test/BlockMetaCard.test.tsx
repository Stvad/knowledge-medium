// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'

// BlockMetaCard is pure presentation over a handful of hooks; mock those so we
// can assert its behaviour (and the two bugs prior review rounds fixed here:
// only the username is linked, and the author page is resolved in the BLOCK's
// workspace) without standing up a repo.
const {useHandleMock, useUserPageMock, useOpenBlockMock, useMinuteClockMock} = vi.hoisted(() => ({
  useHandleMock: vi.fn(),
  useUserPageMock: vi.fn(),
  useOpenBlockMock: vi.fn(),
  useMinuteClockMock: vi.fn(),
}))

vi.mock('@/hooks/block.js', () => ({useHandle: useHandleMock}))
vi.mock('@/hooks/useMinuteClock.js', () => ({useMinuteClock: useMinuteClockMock}))
vi.mock('@/data/globalState.js', () => ({useUserPage: useUserPageMock}))
vi.mock('@/utils/navigation.js', () => ({useOpenBlock: useOpenBlockMock}))

import { BlockMetaCard } from '../BlockMetaCard.tsx'

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0)
const HOUR = 3_600_000

const doc = (over: Partial<BlockData> = {}): Partial<BlockData> => ({
  workspaceId: 'ws-block',
  createdAt: NOW - 48 * HOUR,
  createdBy: 'creator',
  userUpdatedAt: NOW - 2 * HOUR,
  updatedBy: 'editor',
  ...over,
})

// useCardMeta calls useHandle(block, {selector}); drive its real selector with
// our fake row so the field-picking logic is exercised, not bypassed.
const primeRow = (row: Partial<BlockData> | undefined) => {
  useHandleMock.mockImplementation((_block, opts) => opts.selector(row))
}

const block = {id: 'b1'} as Block

beforeEach(() => {
  useOpenBlockMock.mockReturnValue(() => {})
  useMinuteClockMock.mockReturnValue(NOW)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BlockMetaCard', () => {
  it('renders edited/created rows and resolves authors in the block workspace', () => {
    primeRow(doc())
    useUserPageMock.mockImplementation((userId: string) =>
      userId === 'editor'
        ? {name: 'Alice', blockId: 'up-alice'}
        : {name: 'Bob', blockId: 'up-bob'})

    render(<BlockMetaCard block={block}/>)

    expect(screen.getByText('Edited')).toBeTruthy()
    expect(screen.getByText('Created')).toBeTruthy()
    expect(screen.getByText('2h ago')).toBeTruthy()

    // Only the username is a link (the "by " prefix is plain text).
    expect(screen.getByRole('link', {name: 'Alice'})).toBeTruthy()
    expect(screen.getByRole('link', {name: 'Bob'})).toBeTruthy()
    expect(screen.queryByRole('link', {name: 'by Alice'})).toBeNull()

    // Author page resolved against the block's own workspace, not the active one.
    expect(useUserPageMock).toHaveBeenCalledWith('editor', 'ws-block')
    expect(useUserPageMock).toHaveBeenCalledWith('creator', 'ws-block')
  })

  it('shows an em-dash when there is no edit timestamp', () => {
    primeRow(doc({userUpdatedAt: 0}))
    useUserPageMock.mockReturnValue({name: 'Someone', blockId: 'up'})

    render(<BlockMetaCard block={block}/>)
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('renders a system author as plain text (no link)', () => {
    primeRow(doc({updatedBy: 'system:editor'}))
    useUserPageMock.mockImplementation((userId: string) =>
      userId.startsWith('system:') ? {name: 'System'} : {name: 'Bob', blockId: 'up-bob'})

    const {container} = render(<BlockMetaCard block={block}/>)
    expect(screen.queryByRole('link', {name: 'System'})).toBeNull()
    expect(container.textContent).toContain('by System')
  })

  it('shows a placeholder until the row loads', () => {
    primeRow(undefined)
    render(<BlockMetaCard block={block}/>)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })
})
