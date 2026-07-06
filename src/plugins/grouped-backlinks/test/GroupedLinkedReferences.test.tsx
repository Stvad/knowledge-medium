// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.js'
import type { GroupedBacklinksConfig } from '../config.ts'
import type { GroupedBacklinksResult } from '../query.ts'
import { GroupedLinkedReferences } from '../GroupedLinkedReferences.tsx'

const state = vi.hoisted(() => {
  const makeGrouped = (groups: GroupedBacklinksResult['groups']): GroupedBacklinksResult => {
    const sourceIds = Array.from(new Set(groups.flatMap(group => group.sourceIds)))
    return {
      groups,
      total: sourceIds.length,
      unfilteredSourceIds: sourceIds,
      sourceParents: sourceIds.map(sourceId => ({sourceId, parentIds: []})),
    }
  }

  const grouped = makeGrouped([{
    groupId: 'topic',
    label: 'Topic',
    sourceIds: ['src-1'],
    fallback: false,
  }])

  return {
    backlinkMounts: 0,
    liveSubscriptions: 0,
    makeGrouped,
    grouped,
    groupingConfig: {
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    } as GroupedBacklinksConfig,
    repo: undefined as BacklinksViewRendererProps['block']['repo'] | undefined,
  }
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!state.repo) throw new Error('test repo not initialised')
    return state.repo
  },
}))

vi.mock('@/hooks/block.ts', () => ({
  useWorkspaceId: () => 'ws-1',
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => vi.fn(),
}))

vi.mock('@/extensions/runtimeContext.ts', () => ({
  useAppRuntime: () => ({
    read: () => [],
  }),
}))

vi.mock('@/plugins/backlinks/useStoredBacklinkFilter.ts', () => ({
  useBacklinkFilterState: () => ({
    filter: {},
    defaultFilter: {},
    effectiveFilter: {},
    defaultFilterConfigBlock: {id: 'grouped-defaults'},
    setFilter: vi.fn(),
  }),
}))

vi.mock('../useGroupedBacklinksConfig.ts', () => ({
  useGroupedBacklinksConfig: () => state.groupingConfig,
}))

vi.mock('../useGroupedBacklinks.ts', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    useGroupedBacklinks: () => {
      React.useEffect(() => {
        state.liveSubscriptions += 1
        return () => { state.liveSubscriptions -= 1 }
      }, [])
      return state.grouped
    },
  }
})

vi.mock('@/plugins/backlinks/BacklinkEntry.tsx', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    LazyBacklinkItem: ({block}: {block: {id: string}}) => {
      const [mountId] = React.useState(() => ++state.backlinkMounts)
      return React.createElement(
        'div',
        {'data-testid': `backlink-${block.id}`},
        `${block.id} mount ${mountId}`,
      )
    },
  }
})

const groupButtonLabels = (): string[] =>
  screen.getAllByRole('button')
    .map(button => button.textContent ?? '')
    .map(text => text.replace(/[▾▸]/g, '').replace(/\d+$/, '').trim())
    .filter(label => ['Alpha', 'Beta', 'Gamma', 'Other', 'Topic'].includes(label))

describe('GroupedLinkedReferences live updates toggle', () => {
  beforeEach(() => {
    state.backlinkMounts = 0
    state.liveSubscriptions = 0
    state.grouped = state.makeGrouped([{
      groupId: 'topic',
      label: 'Topic',
      sourceIds: ['src-1'],
      fallback: false,
    }])
    state.groupingConfig = {
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }

    const repo = {
      activeWorkspaceId: 'ws-1',
      block: (id: string) => ({id, repo}),
      query: {},
    } as unknown as BacklinksViewRendererProps['block']['repo']
    state.repo = repo
  })

  afterEach(() => {
    cleanup()
    state.repo = undefined
  })

  it('pauses the live subscription without remounting the visible backlink rows', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']

    render(<GroupedLinkedReferences block={block} />)

    const item = await screen.findByTestId('backlink-src-1')
    expect(item).toHaveTextContent('src-1 mount 1')
    await waitFor(() => expect(state.liveSubscriptions).toBe(1))

    fireEvent.click(screen.getByRole('button', {name: 'Pause live updates'}))

    await waitFor(() => expect(state.liveSubscriptions).toBe(0))
    expect(screen.getByRole('button', {name: 'Resume live updates'})).toBeInTheDocument()
    expect(screen.getByTestId('backlink-src-1')).toBe(item)
    expect(screen.getByTestId('backlink-src-1')).toHaveTextContent('src-1 mount 1')
  })

  it('keeps the first mounted group order while live results change', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b', 'src-c'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'other', label: 'Other', sourceIds: ['src-d'], fallback: true},
    ])
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta', 'Other']))
  })

  it('remembers missing group slots and appends new groups', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
    ])
    rerender(<GroupedLinkedReferences block={block} />)
    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta', 'Gamma']))

    state.grouped = state.makeGrouped([
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta', 'Gamma']))
  })

  it('resets the mounted group order when the grouping query args change', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])
    state.groupingConfig = {
      highPriorityTags: ['Beta'],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta', 'Alpha']))
  })
})
