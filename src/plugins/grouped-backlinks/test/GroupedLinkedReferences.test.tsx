// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.js'
import type { GroupedBacklinksGroupHeaderAction } from '../facet.ts'
import type { GroupedBacklinksResult } from '../query.ts'
import { GroupedLinkedReferences } from '../GroupedLinkedReferences.tsx'

interface StubBlockData {
  content: string
}

const state = vi.hoisted(() => {
  const grouped: GroupedBacklinksResult = {
    groups: [{
      groupId: 'topic',
      label: 'Topic',
      sourceIds: ['src-1'],
      fallback: false,
    }],
    total: 1,
    unfilteredSourceIds: ['src-1'],
    sourceParents: [{sourceId: 'src-1', parentIds: []}],
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
    headerActions: [] as GroupedBacklinksGroupHeaderAction[],
    blockStore: new Map<string, StubBlockData>(),
    blockListeners: new Map<string, Set<() => void>>(),
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
    read: () => state.headerActions,
  }),
}))

// Stub the header-action button with the same visibility contract as the
// real one: it renders nothing unless a source block's content satisfies
// the gate (here, carries a date reference — the real `isVisible` reads
// `block.peek()` via `hasAnyBlockDateAdapter`). This lets the test drive
// the regression: the button must appear once its source hydrates.
vi.mock('../GroupHeaderActionButton.tsx', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    GroupHeaderActionButton: ({
      sourceBlocks,
    }: {
      sourceBlocks: {peek: () => StubBlockData | undefined}[]
    }) => {
      const visible = sourceBlocks.some(block =>
        block.peek()?.content.includes('[[2026-07-02]]'),
      )
      if (!visible) return null
      return React.createElement('button', {'data-testid': 'header-action'}, 'spread')
    },
  }
})

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
    state.headerActions = []
    state.blockStore = new Map()
    state.blockListeners = new Map()

    const repo = {
      activeWorkspaceId: 'ws-1',
      // Cache-backed facade: `peek` reads the store, `subscribe` registers a
      // cache listener. Mirrors the live Block just enough to exercise the
      // header-action visibility gate + its lazy-hydration re-render.
      block: (id: string) => ({
        id,
        repo,
        peek: () => state.blockStore.get(id),
        subscribe: (listener: () => void) => {
          let listeners = state.blockListeners.get(id)
          if (!listeners) {
            listeners = new Set()
            state.blockListeners.set(id, listeners)
          }
          listeners.add(listener)
          return () => { listeners!.delete(listener) }
        },
      }),
      query: {},
    } as unknown as BacklinksViewRendererProps['block']['repo']
    state.repo = repo
  })

  afterEach(() => {
    cleanup()
    state.repo = undefined
  })

  const hydrateSource = (id: string, content: string) => {
    act(() => {
      state.blockStore.set(id, {content})
      state.blockListeners.get(id)?.forEach(listener => listener())
    })
  }

  it('reveals a group-header action once its source block hydrates', async () => {
    state.headerActions = [{actionId: 'multi_select.block.date.spread'}]
    const block = {id: 'target', repo: state.repo!} as BacklinksViewRendererProps['block']

    render(<GroupedLinkedReferences block={block} />)

    // Group renders while its source is still an unhydrated id — the gate
    // (peek() === undefined) hides the button. This is the regression state:
    // without a cache subscription it would stay hidden forever.
    await screen.findByTestId('backlink-src-1')
    expect(screen.queryByTestId('header-action')).toBeNull()

    // The lazy entry hydrates the source with a date reference; the header
    // row must re-run its gate and surface the action.
    hydrateSource('src-1', 'todo [[2026-07-02]]')

    await waitFor(() =>
      expect(screen.getByTestId('header-action')).toBeInTheDocument(),
    )
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
