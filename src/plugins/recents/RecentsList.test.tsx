// @vitest-environment happy-dom
/** Wiring test for the Recents feed: that it asks for user-authored rows
 *  only, and that one activity entry renders as one row with its members
 *  collapsed. The grouping itself is covered by `grouping.test.ts`. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BlockData } from '@/data/api'

interface StubHandle { value: unknown }

const state = vi.hoisted(() => ({
  recentArgs: undefined as Record<string, unknown> | undefined,
  rows: [] as BlockData[],
  ancestors: [] as {startId: string; ancestors: BlockData[]}[],
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({
    query: {
      recentBlocks: (args: Record<string, unknown>): StubHandle => {
        state.recentArgs = args
        return {value: state.rows}
      },
      manyAncestors: (): StubHandle => ({value: state.ancestors}),
    },
  }),
}))

vi.mock('@/hooks/block.js', () => ({
  useHandle: (handle: StubHandle, opts: {selector: (v: unknown) => unknown}) =>
    opts.selector(handle.value),
}))

vi.mock('@/hooks/useMinuteClock.js', () => ({useMinuteClock: () => T0}))

// The real ones need a block-render tree / an IntersectionObserver; this
// test is about which rows the feed produces, not how they mount.
vi.mock('@/components/util/LazyViewportMount.js', () => ({
  LazyViewportMount: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
}))
vi.mock('@/components/references/BlockRef.js', () => ({
  BlockRef: ({blockId}: {blockId: string}) => <span>{blockId}</span>,
}))

const T0 = 1_700_000_000_000

const block = (id: string, parentId: string | null, agoMs: number, page = false): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId,
  orderKey: 'a0',
  content: id,
  properties: page ? {types: ['page']} : {},
  references: [],
  createdAt: T0,
  updatedAt: T0 - agoMs,
  userUpdatedAt: T0 - agoMs,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
} as BlockData)

afterEach(() => {
  state.recentArgs = undefined
  state.rows = []
  state.ancestors = []
  cleanup()
})

// Imported after the mocks so the component picks them up.
const { RecentsList } = await import('./RecentsPageBlockRenderer.tsx')

describe('RecentsList', () => {
  it('asks the query to exclude app-owned rows', () => {
    render(<RecentsList workspaceId="ws"/>)
    expect(state.recentArgs).toMatchObject({workspaceId: 'ws', excludeSystem: true})
  })

  it('renders one row per activity entry, with members collapsed behind "+N more"', () => {
    const page = block('page', null, 0, true)
    const members = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, i) => block(id, 'page', i * 1000))
    state.rows = members
    state.ancestors = members.map(m => ({startId: m.id, ancestors: [page]}))

    render(<RecentsList workspaceId="ws"/>)

    // One entry: the page, with all five edits under it.
    expect(screen.getByRole('list', {name: 'Recent activity'}).children).toHaveLength(1)
    expect(screen.getByText('page')).toBeInTheDocument()
    expect(screen.getByText('5 blocks changed')).toBeInTheDocument()
    expect(screen.getByText('m1')).toBeInTheDocument()
    expect(screen.queryByText('m4')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {name: '+2 more'}))
    expect(screen.getByText('m4')).toBeInTheDocument()
    expect(screen.getByText('m5')).toBeInTheDocument()
  })

  it('shows the empty state when nothing recent survives the filter', () => {
    render(<RecentsList workspaceId="ws"/>)
    expect(screen.getByText(/No recent edits yet/)).toBeInTheDocument()
  })
})
