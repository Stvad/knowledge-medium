// @vitest-environment happy-dom
/**
 * The prop→DOM half of the layout-stability claim.
 *
 * `linkedReferencesRefresh` stubs the entry renderer, because the blank
 * frame it hunts settles inside `act` and only a per-render recorder can
 * see it. That leaves an assumption unpinned: that a non-empty
 * `initialParents` actually reaches the DOM as a breadcrumb line. If
 * `BacklinkEntry` stopped threading its parents into
 * `PromotableBreadcrumbList`, the panel would collapse exactly as it did
 * before the fix and every assertion over there would still pass.
 *
 * So this file drives the REAL entry, breadcrumb list and breadcrumb
 * renderer over a real repo — only `BlockComponent` (the leaf) and the
 * viewport-mount gate are stubbed — and asserts on breadcrumb node
 * VALUES, before and after a live refresh.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ChangeScope, type BlockReference } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { BlockContextProvider } from '@/context/block'
import { queriesFacet, invalidationRulesFacet } from '@/data/facets.js'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import type { AppExtension } from '@/facets/facet.js'
import { backlinksForBlockQuery } from '../query.ts'
import { LinkedReferences } from '../LinkedReferences.tsx'

const WS = 'ws-1'
const TARGET = 'target-page'

const state = vi.hoisted(() => ({repo: undefined as unknown, emptyFilter: {}}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!state.repo) throw new Error('test repo not initialised')
    return state.repo
  },
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => vi.fn(),
}))

vi.mock('../useStoredBacklinkFilter.ts', () => ({
  useBacklinkFilterState: () => ({
    filter: state.emptyFilter,
    defaultFilter: state.emptyFilter,
    effectiveFilter: state.emptyFilter,
    defaultFilterConfigBlock: {id: 'backlink-defaults'},
    setFilter: vi.fn(),
  }),
}))

// The leaf: every breadcrumb segment and every entry body renders one,
// so its testid is how a rendered node is identified by VALUE.
vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <span data-testid={`block-${blockId}`}>{blockId}</span>
  ),
}))

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

const backlinksQueryExtension: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
]

let sharedDb: TestDb
let repo: Repo

const create = async (args: {
  id: string
  parentId?: string | null
  references?: BlockReference[]
}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: args.parentId ?? null,
      orderKey: `key-${args.id}`,
      content: args.id,
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

const createSource = async (id: string) => {
  await create({id: `${id}-parent`})
  await create({id, parentId: `${id}-parent`, references: [{id: TARGET, alias: TARGET}]})
}

/** The breadcrumb segment for `sourceId`, as an anchor in the DOM. */
const breadcrumbFor = (sourceId: string) =>
  screen.queryByTestId(`block-${sourceId}-parent`)?.closest('a') ?? null

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    startSyncObserver: true,
    extensions: [backlinksQueryExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
  state.repo = repo
  await create({id: TARGET})
})

afterEach(() => {
  cleanup()
  repo.stopSyncObserver()
})

describe('LinkedReferences breadcrumb rendering', () => {
  it('renders a real breadcrumb node per entry, and keeps it across a refresh', async () => {
    await createSource('src-1')
    await createSource('src-2')

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LinkedReferences block={repo.block(TARGET)}/>
      </BlockContextProvider>,
    )

    // The chain reached the DOM as a real, clickable breadcrumb — not
    // merely as a prop the stubbed renderer echoed back.
    await waitFor(() => {
      expect(breadcrumbFor('src-1')).not.toBeNull()
      expect(breadcrumbFor('src-2')).not.toBeNull()
    })
    expect(breadcrumbFor('src-1')?.textContent).toBe('src-1-parent')

    await act(async () => { await createSource('src-3') })

    await waitFor(() => { expect(breadcrumbFor('src-3')).not.toBeNull() })
    expect(breadcrumbFor('src-1')?.textContent).toBe('src-1-parent')
    expect(breadcrumbFor('src-2')?.textContent).toBe('src-2-parent')
  })

  it('renders no breadcrumb line for a top-level source', async () => {
    // Pins the other direction: an empty chain must render nothing, so
    // the refresh test's "breadcrumbs vanished" signal means what it says.
    await create({id: 'root-src', references: [{id: TARGET, alias: TARGET}]})

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LinkedReferences block={repo.block(TARGET)}/>
      </BlockContextProvider>,
    )

    await waitFor(() => { expect(screen.getByTestId('block-root-src')).toBeTruthy() })
    expect(screen.queryByRole('link')).toBeNull()
  })
})
