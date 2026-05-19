// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BlockData } from '@/data/api'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.ts'
import type { GroupedBacklinksResult } from '../query.ts'
import { GroupedLinkedReferences } from '../GroupedLinkedReferences.tsx'

const state = vi.hoisted(() => {
  const grouped: GroupedBacklinksResult = {
    groups: [{
      groupId: 'topic',
      label: 'Topic',
      sourceIds: ['src-1'],
      fallback: false,
    }],
    total: 1,
    unfilteredSources: [{id: 'src-1'} as BlockData],
    sourceParents: [{sourceId: 'src-1', parents: []}],
  }

  return {
    backlinkMounts: 0,
    liveSubscriptions: 0,
    grouped,
    groupingConfig: {
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    },
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
  useNavigateFromGlobalCommand: () => vi.fn(),
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

describe('GroupedLinkedReferences live updates toggle', () => {
  beforeEach(() => {
    state.backlinkMounts = 0
    state.liveSubscriptions = 0

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
})
