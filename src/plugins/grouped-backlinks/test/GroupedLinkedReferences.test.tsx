// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.js'
import type { GroupedBacklinksConfig } from '../config.ts'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  type GroupedBacklinksResult,
} from '../query.ts'
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
    groupedLoadResult: undefined as GroupedBacklinksResult | undefined,
    groupedLoadQueue: [] as Array<GroupedBacklinksResult | Promise<GroupedBacklinksResult>>,
    groupedLoadErrors: [] as Error[],
    groupedLoadError: undefined as Error | undefined,
    liveListeners: [] as Array<(value: GroupedBacklinksResult) => void>,
    emptyFilter: {},
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
    filter: state.emptyFilter,
    defaultFilter: state.emptyFilter,
    effectiveFilter: state.emptyFilter,
    defaultFilterConfigBlock: {id: 'grouped-defaults'},
    setFilter: vi.fn(),
  }),
}))

vi.mock('../useGroupedBacklinksConfig.ts', () => ({
  useGroupedBacklinksConfig: () => state.groupingConfig,
}))

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
    .filter(label => label && label !== 'Grouped References')

const emitGrouped = async () => {
  await act(async () => {
    for (const listener of state.liveListeners) listener(state.grouped)
  })
}

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
    state.groupedLoadResult = undefined
    state.groupedLoadQueue = []
    state.groupedLoadErrors = []
    state.groupedLoadError = undefined
    state.liveListeners = []
    state.groupingConfig = {
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }

    const repo = {
      activeWorkspaceId: 'ws-1',
      block: (id: string) => ({id, repo}),
      query: {
        [GROUPED_BACKLINKS_FOR_BLOCK_QUERY]: (args: unknown) => ({
          key: `${GROUPED_BACKLINKS_FOR_BLOCK_QUERY}:${JSON.stringify(args)}`,
          load: () => {
            const queuedError = state.groupedLoadErrors.shift()
            if (queuedError) return Promise.reject(queuedError)
            if (state.groupedLoadError) {
              const error = state.groupedLoadError
              state.groupedLoadError = undefined
              return Promise.reject(error)
            }
            return Promise.resolve(
              state.groupedLoadQueue.shift() ?? state.groupedLoadResult ?? state.grouped,
            )
          },
          subscribe: (listener: (value: GroupedBacklinksResult) => void) => {
            state.liveSubscriptions += 1
            state.liveListeners.push(listener)
            return () => {
              state.liveSubscriptions -= 1
              state.liveListeners = state.liveListeners.filter(entry => entry !== listener)
            }
          },
        }),
      },
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

  it('refreshes with retry when live updates resume', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha']))
    fireEvent.click(screen.getByRole('button', {name: 'Pause live updates'}))
    await waitFor(() => expect(state.liveSubscriptions).toBe(0))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    state.groupedLoadError = new Error('transient resume failure')
    fireEvent.click(screen.getByRole('button', {name: 'Resume live updates'}))

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta']))
  })

  it('keeps the first mounted group order while live results change', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))
    await waitFor(() => expect(state.liveSubscriptions).toBe(1))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b', 'src-c'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'other', label: 'Other', sourceIds: ['src-d'], fallback: true},
    ])
    await emitGrouped()
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta', 'Other']))
  })

  it('keeps existing backlink rows assigned to their first rendered group', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'dance', label: 'Dance', sourceIds: ['src-a', 'src-b', 'src-c'], fallback: false},
      {groupId: 'practice', label: 'Practice', sourceIds: ['src-d'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance', 'Practice']))
    await waitFor(() => expect(screen.getByRole('button', {name: /Dance\s*3/})).toBeInTheDocument())

    state.grouped = state.makeGrouped([
      {groupId: 'matrix', label: 'Matrix', sourceIds: ['src-b'], fallback: false},
      {groupId: 'lesson', label: 'Lesson', sourceIds: ['src-c'], fallback: false},
      {groupId: 'practice', label: 'Practice', sourceIds: ['src-d'], fallback: false},
    ])
    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance', 'Practice']))
    expect(screen.getByRole('button', {name: /Dance\s*2/})).toBeInTheDocument()
    expect(screen.queryByText('Matrix')).not.toBeInTheDocument()
    expect(screen.queryByText('Lesson')).not.toBeInTheDocument()
  })

  it('appends genuinely new groups without moving already assigned rows', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'dance', label: 'Dance', sourceIds: ['src-a', 'src-b'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance']))

    state.grouped = state.makeGrouped([
      {groupId: 'matrix', label: 'Matrix', sourceIds: ['src-a', 'src-c'], fallback: false},
      {groupId: 'dance', label: 'Dance', sourceIds: ['src-b'], fallback: false},
    ])
    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance', 'Matrix']))
    expect(screen.getByRole('button', {name: /Dance\s*2/})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /Matrix\s*1/})).toBeInTheDocument()
  })

  it('prevents earlier groups from stealing rows already assigned to later groups', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a', 'src-b'], fallback: false},
    ])
    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))
    expect(screen.getByRole('button', {name: /Alpha\s*1/})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /Beta\s*1/})).toBeInTheDocument()
    expect(screen.getByTestId('backlink-src-a')).toHaveTextContent('src-a mount 1')
    expect(screen.getByTestId('backlink-src-b')).toHaveTextContent('src-b mount 2')
  })

  it('remembers row ownership while a row is temporarily absent', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'dance', label: 'Dance', sourceIds: ['src-a'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance']))

    state.grouped = state.makeGrouped([])
    await emitGrouped()
    await waitFor(() => expect(screen.queryByText('Dance')).not.toBeInTheDocument())

    state.grouped = state.makeGrouped([
      {groupId: 'matrix', label: 'Matrix', sourceIds: ['src-a'], fallback: false},
    ])
    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Dance']))
    expect(screen.getByTestId('backlink-src-a')).toHaveTextContent('src-a mount 2')
    expect(screen.queryByText('Matrix')).not.toBeInTheDocument()
  })

  it('keeps existing fallback rows assigned to the fallback group', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'other', label: 'Other', sourceIds: ['src-a'], fallback: true},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Other']))

    state.grouped = state.makeGrouped([
      {groupId: 'project', label: 'Project', sourceIds: ['src-a', 'src-b'], fallback: false},
    ])
    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Project', 'Other']))
    expect(screen.getByRole('button', {name: /Project\s*1/})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /Other\s*1/})).toBeInTheDocument()
    expect(screen.getByTestId('backlink-src-a')).toHaveTextContent('src-a mount 1')
    expect(screen.getByTestId('backlink-src-b')).toHaveTextContent('src-b mount 2')
  })

  it('allows source-field groups to share field-assigned rows', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'field:reviewer', label: 'Reviewer', sourceIds: ['src-a'], fallback: false},
      {groupId: 'field:status', label: 'Status', sourceIds: ['src-a'], fallback: false},
    ])

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Reviewer', 'Status']))
    expect(screen.getAllByTestId('backlink-src-a')).toHaveLength(2)
  })

  it('remembers missing group slots and appends new groups', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))
    await waitFor(() => expect(state.liveSubscriptions).toBe(1))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
    ])
    await emitGrouped()
    rerender(<GroupedLinkedReferences block={block} />)
    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta', 'Gamma']))

    state.grouped = state.makeGrouped([
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    await emitGrouped()
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

  it('does not render a stale snapshot while a query-key refresh is pending', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha']))

    state.groupedLoadQueue = [new Promise<GroupedBacklinksResult>(() => {})]
    state.groupingConfig = {
      highPriorityTags: ['Beta'],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('does not reuse an old snapshot after switching away and back to a query key', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.groupedLoadQueue = [
      new Promise<GroupedBacklinksResult>(() => {}),
      new Promise<GroupedBacklinksResult>(() => {}),
    ]
    state.groupingConfig = {
      highPriorityTags: ['Beta'],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()

    state.groupingConfig = {
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('does not seed a reset baseline from a stale live value', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    state.groupedLoadResult = state.makeGrouped([
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

  it('drains repeated dirty mid-load results before seeding a reset baseline', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))

    const stale = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    const fresh = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])
    state.grouped = stale
    const dirtyOne = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
    ])
    const dirtyTwo = state.makeGrouped([
      {groupId: 'gamma', label: 'Gamma', sourceIds: ['src-g'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])
    const dirtyThree = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'delta', label: 'Delta', sourceIds: ['src-d'], fallback: false},
    ])
    const dirtyFour = state.makeGrouped([
      {groupId: 'delta', label: 'Delta', sourceIds: ['src-d'], fallback: false},
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])
    state.groupedLoadQueue = [stale, dirtyOne, dirtyTwo, dirtyThree, dirtyFour, fresh, fresh]
    state.groupingConfig = {
      highPriorityTags: ['Beta'],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta', 'Alpha']))
  })

  it('retries a failed initial load for the current query key', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    state.groupedLoadError = new Error('transient load failure')

    render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(state.liveSubscriptions).toBe(1))
    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha', 'Beta']))
  })

  it('clears a stale snapshot when a query-key refresh fails', async () => {
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']
    state.grouped = state.makeGrouped([
      {groupId: 'alpha', label: 'Alpha', sourceIds: ['src-a'], fallback: false},
    ])

    const {rerender} = render(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Alpha']))

    state.grouped = state.makeGrouped([
      {groupId: 'beta', label: 'Beta', sourceIds: ['src-b'], fallback: false},
    ])
    state.groupedLoadErrors = [
      new Error('transient load failure'),
      new Error('still failing'),
    ]
    state.groupingConfig = {
      highPriorityTags: ['Beta'],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    }
    rerender(<GroupedLinkedReferences block={block} />)

    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())

    await emitGrouped()

    await waitFor(() => expect(groupButtonLabels()).toEqual(['Beta']))
  })
})
