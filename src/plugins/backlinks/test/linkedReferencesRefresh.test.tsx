// @vitest-environment happy-dom
/**
 * Layout stability across a LIVE backlinks refresh.
 *
 * The list and the breadcrumb chains come from two different handles:
 * `backlinks.forBlock` (keyed by the target block) and
 * `core.manyAncestors` (keyed by the *set* of source ids). Every add or
 * remove changes the id set, so the ancestors handle is a NEW handle —
 * cold, `peek() === undefined`. Without stickiness that renders as
 * "every entry has no parents", `BreadcrumbList` returns null for all of
 * them, and the whole section loses one line per visible entry until the
 * ancestors load resolves — the jump the user sees.
 *
 * These tests drive the real `LinkedReferences` over a real repo and
 * record what each entry was rendered with on EVERY commit (the flash
 * settles inside `act`, so a post-hoc DOM assertion can't see it). Only
 * the leaf entry renderer is stubbed, to capture its props.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ChangeScope, type BlockReference } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { queriesFacet, invalidationRulesFacet } from '@/data/facets.js'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import type { AppExtension } from '@/facets/facet.js'
import { backlinksForBlockQuery } from '../query.ts'
import { LinkedReferences } from '../LinkedReferences.tsx'

const WS = 'ws-1'
const TARGET = 'target-page'

interface EntryRender {
  id: string
  parents: string[]
}

const state = vi.hoisted(() => ({
  repo: undefined as unknown,
  entryRenders: [] as EntryRender[],
  emptyFilter: {},
}))

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

// The entry renderer is the observation point: `initialParents` is what
// decides whether the entry paints a breadcrumb line (see BacklinkEntry →
// BreadcrumbList, which renders null for an empty chain).
vi.mock('../BacklinkEntry.tsx', () => ({
  LazyBacklinkItem: ({block, initialParents}: {
    block: Block
    initialParents?: readonly Block[]
  }) => {
    const parents = (initialParents ?? []).map(parent => parent.id)
    state.entryRenders.push({id: block.id, parents})
    return <div data-testid={`backlink-${block.id}`}>{parents.join('>')}</div>
  },
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

/** A source block nested under its own parent, so it HAS a breadcrumb. */
const createSource = async (id: string) => {
  await create({id: `${id}-parent`})
  await create({
    id,
    parentId: `${id}-parent`,
    references: [{id: TARGET, alias: TARGET}],
  })
}

const renderPanel = async (expectedIds: string[]) => {
  const rendered = render(<LinkedReferences block={repo.block(TARGET)}/>)
  await waitFor(() => {
    for (const id of expectedIds) {
      expect(rendered.getByTestId(`backlink-${id}`).textContent).toBe(`${id}-parent`)
    }
  })
  return rendered
}

/** Every render an entry got, from the point the log was last cleared. */
const rendersFor = (id: string): EntryRender[] =>
  state.entryRenders.filter(entry => entry.id === id)

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
  state.entryRenders = []
  await create({id: TARGET})
})

afterEach(() => {
  cleanup()
  repo.stopSyncObserver()
})

describe('LinkedReferences layout stability across a live refresh', () => {
  it('keeps the surviving entries breadcrumbed when a backlink is removed', async () => {
    await createSource('src-1')
    await createSource('src-2')
    await createSource('src-3')
    await renderPanel(['src-1', 'src-2', 'src-3'])
    state.entryRenders = []

    await act(async () => {
      await repo.tx(tx => tx.delete('src-3'), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => {
      expect(state.entryRenders.some(entry => entry.id === 'src-1')).toBe(true)
    })

    // Not one commit in between may drop their breadcrumb line — that
    // drop is what collapses the section's height.
    for (const id of ['src-1', 'src-2']) {
      expect(rendersFor(id).map(entry => entry.parents)).not.toContainEqual([])
    }
  })

  it('keeps the existing entries breadcrumbed when a backlink is added', async () => {
    await createSource('src-1')
    await createSource('src-2')
    await renderPanel(['src-1', 'src-2'])
    state.entryRenders = []

    await act(async () => { await createSource('src-3') })
    await waitFor(() => {
      expect(rendersFor('src-3').at(-1)?.parents).toEqual(['src-3-parent'])
    })

    for (const id of ['src-1', 'src-2']) {
      expect(rendersFor(id).map(entry => entry.parents)).not.toContainEqual([])
    }
  })

  it('drops the breadcrumbs of an entry whose parent chain really went away', async () => {
    await createSource('src-1')
    await createSource('src-2')
    await renderPanel(['src-1', 'src-2'])

    // Reparenting to the root is a real change, not a load gap: the
    // sticky path must not keep serving the stale chain.
    await act(async () => {
      await repo.tx(tx => tx.move('src-2', {parentId: null, orderKey: 'key-src-2'}), {
        scope: ChangeScope.BlockDefault,
      })
    })

    await waitFor(() => {
      expect(rendersFor('src-2').at(-1)?.parents).toEqual([])
    })
  })
})
