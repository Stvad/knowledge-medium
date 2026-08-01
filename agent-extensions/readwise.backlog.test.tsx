// @vitest-environment happy-dom
//
// The review backlog's whole value is "which highlights does it show, in what
// order, and what happens when I mark one" — so the query runs against a REAL
// repo with real daily notes and real property schemas, and the assertions are
// on which seeded highlights come back. An object-shape assertion on the query
// would pass just as happily with the `exclude`/`match` trap below reintroduced.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { ChangeScope } from '@/data/api/index.js'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { typesProp } from '@/data/properties.js'
import type { AppExtension } from '@/facets/facet.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes.js'
import type { BlockRendererProps } from '@/types.js'

import readwiseContributions, {
  buildUnreviewedHighlightsQuery,
  groupHighlightIds,
  useStickyIds,
} from './readwise.tsx'

const HIGHLIGHT_TYPE = 'readwise-highlight'
const BACKLOG_TYPE = 'readwise-review-backlog'
const REVIEWED_PROP = 'readwise:reviewed'
const REVIEW_DATE_PROP = 'readwise:review_date'
const WS = 'ws-1'

// "Now" for every case below. Fixed so the boundary maths is deterministic.
const NOW = new Date(2026, 6, 20, 10, 0)
const TODAY = '2026-07-20'
const YESTERDAY = '2026-07-19'
const TOMORROW = '2026-07-21'

const readwiseDataAndUi = readwiseContributions
  .filter(c => !['core.app-mounts', 'core.app-effects'].includes(c.facet.id)) as unknown as AppExtension[]

let sharedDb: TestDb

const setup = () => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    extensions: [dailyNotesDataExtension, ...readwiseDataAndUi],
  })
  return {repo, runtime: repo.facetRuntime!}
}

/** A document page with a Highlights section under it — the shape the sync
 *  actually writes, which is what makes `parentId` a usable grouping key. */
const seedDocument = async (repo: Repo, docId: string, title: string) => {
  await repo.tx(async tx => {
    await tx.create({id: docId, workspaceId: WS, parentId: null, orderKey: 'a0', content: title})
    await tx.create({
      id: `${docId}-hl`, workspaceId: WS, parentId: docId, orderKey: 'a0', content: 'Highlights',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed doc'})
  return `${docId}-hl`
}

interface SeedHighlight {
  id: string
  sectionId: string
  /** ISO day its `review_date` ref points at, or null for no ref at all. */
  scheduled: string | null
  reviewed?: boolean | undefined
  orderKey?: string
}

const seedHighlight = async (repo: Repo, spec: SeedHighlight) => {
  const noteId = spec.scheduled
    ? (await getOrCreateDailyNote(repo, WS, spec.scheduled)).id
    : null
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    await tx.create({
      id: spec.id,
      workspaceId: WS,
      parentId: spec.sectionId,
      orderKey: spec.orderKey ?? 'a0',
      content: `highlight ${spec.id}`,
    })
    await repo.addTypeInTx(tx, spec.id, HIGHLIGHT_TYPE, {
      ...(noteId ? {[REVIEW_DATE_PROP]: noteId} : {}),
      // `reviewed: undefined` leaves the cell entirely UNSET, which is the
      // pre-latch / raw-sync shape the exclude form has to survive.
      ...(spec.reviewed === undefined ? {} : {[REVIEWED_PROP]: spec.reviewed}),
    }, snapshot)
  }, {scope: ChangeScope.BlockDefault, description: `seed ${spec.id}`})
}

const backlogIds = async (repo: Repo): Promise<string[]> => {
  const rows = await repo.queryBlocks(buildUnreviewedHighlightsQuery(WS, NOW))
  return rows.map(row => row.id)
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { cleanup() })

describe('unreviewed backlog query', () => {
  it('collects unreviewed highlights scheduled today or earlier', async () => {
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await seedHighlight(repo, {id: 'old', sectionId: section, scheduled: YESTERDAY, orderKey: 'a0'})
    await seedHighlight(repo, {id: 'today', sectionId: section, scheduled: TODAY, orderKey: 'a1'})

    expect((await backlogIds(repo)).sort()).toEqual(['old', 'today'])
  })

  it('leaves out a highlight scheduled for tomorrow', async () => {
    // The boundary is the point of the whole feature: a backlog that swept in
    // future-dated highlights would be every highlight you own.
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await seedHighlight(repo, {id: 'later', sectionId: section, scheduled: TOMORROW})

    expect(await backlogIds(repo)).toEqual([])
  })

  it('leaves out a highlight already marked reviewed', async () => {
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await seedHighlight(repo, {id: 'done', sectionId: section, scheduled: YESTERDAY, reviewed: true})

    expect(await backlogIds(repo)).toEqual([])
  })

  it('KEEPS a highlight whose reviewed property was never written', async () => {
    // The trap this pins: `match {reviewed: false}` compiles to SQL equality,
    // which never matches a NULL cell — so it would silently drop every
    // highlight imported before the latch existed, or arriving raw over sync.
    // Excluding `reviewed: true` is the only shape that keeps them.
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await seedHighlight(repo, {id: 'unset', sectionId: section, scheduled: YESTERDAY, reviewed: undefined})

    expect(await backlogIds(repo)).toEqual(['unset'])
  })

  it('leaves out a highlight with no review date at all', async () => {
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await seedHighlight(repo, {id: 'unscheduled', sectionId: section, scheduled: null})

    expect(await backlogIds(repo)).toEqual([])
  })

  it('leaves out a non-highlight block sitting in the same section', async () => {
    const {repo} = setup()
    const section = await seedDocument(repo, 'doc-1', 'A Book')
    await repo.tx(async tx => {
      await tx.create({
        id: 'plain', workspaceId: WS, parentId: section, orderKey: 'a9', content: 'a note',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed plain'})

    expect(await backlogIds(repo)).toEqual([])
  })
})

describe('grouping', () => {
  /** Stand-in for `repo.block(id).peek()`. */
  const reader = (rows: Record<string, BlockData | null>) =>
    (id: string) => rows[id] ?? null

  // The grouper reads each id's CURRENT block, so the rows need real type tags —
  // spelled through `typesProp` rather than a literal key, since guessing it
  // wrong makes every one of these pass as "not a highlight".
  const typed = (id: string, parentId: string | null, types: string[] = [HIGHLIGHT_TYPE]) =>
    ({
      id, parentId, deleted: false,
      properties: {[typesProp.name]: typesProp.codec.encode(types)},
    } as unknown as BlockData)

  it('groups by the block\'s current parent, in first-seen order', () => {
    // Ids arrive `created-asc`, so first appearance is oldest-first — and
    // because `review_date` is stamped at import, that tracks scheduled order.
    const rows = {
      a1: typed('a1', 'sec-a'), b1: typed('b1', 'sec-b'),
      a2: typed('a2', 'sec-a'), b2: typed('b2', 'sec-b'),
    }
    const groups = groupHighlightIds(['a1', 'b1', 'a2', 'b2'], reader(rows))

    expect(groups.map(g => g.sectionId)).toEqual(['sec-a', 'sec-b'])
    expect(groups.map(g => g.items)).toEqual([['a1', 'a2'], ['b1', 'b2']])
  })

  it('follows a MOVED highlight to its new parent', () => {
    // The point of reading live rather than keeping a snapshot: the id set
    // cannot go stale, because it holds no copy of the block to go stale.
    const groups = groupHighlightIds(['x'], reader({x: typed('x', 'sec-moved')}))
    expect(groups).toEqual([{sectionId: 'sec-moved', items: ['x']}])
  })

  it('drops ids whose block is gone, deleted, or no longer a highlight', () => {
    // Each of these used to need its own "why did this row leave the query"
    // branch in the sticky reconciliation. Reading live, they are one rule.
    const rows: Record<string, BlockData | null> = {
      missing: null,
      gone: {...typed('gone', 'sec'), deleted: true} as BlockData,
      untagged: typed('untagged', 'sec', ['page']),
      kept: typed('kept', 'sec'),
    }
    const groups = groupHighlightIds(
      ['missing', 'gone', 'untagged', 'kept'], reader(rows),
    )
    expect(groups).toEqual([{sectionId: 'sec', items: ['kept']}])
  })

  it('does not merge parentless rows into a real section', () => {
    const groups = groupHighlightIds(
      ['orphan', 'x'], reader({orphan: typed('orphan', null), x: typed('x', 'sec-a')}),
    )
    expect(groups.map(g => g.sectionId)).toEqual(['', 'sec-a'])
  })
})

describe('sticky ids', () => {
  const Probe = ({live, onRender}: {
    live: readonly string[]
    onRender: (ids: readonly string[], reset: () => void) => void
  }) => {
    const [ids, reset] = useStickyIds(live)
    onRender(ids, reset)
    return <span>{ids.join(',')}</span>
  }

  it('keeps an id that dropped out of the live set', async () => {
    // What "mark reviewed" does. Without this the row vanishes and everything
    // below jumps up under the cursor — the problem SRS review answers with a
    // frozen queue, a persisted index and a reconcile pass.
    let latest: readonly string[] = []
    const capture = (ids: readonly string[]) => { latest = ids }
    const {rerender} = render(<Probe live={['a', 'b']} onRender={capture}/>)
    expect(latest).toEqual(['a', 'b'])

    await act(async () => { rerender(<Probe live={['b']} onRender={capture}/>) })

    expect(latest).toEqual(['a', 'b'])
    expect(screen.getByText('a,b')).toBeTruthy()
  })

  it('appends newly-arriving ids at the end rather than reordering', async () => {
    let latest: readonly string[] = []
    const capture = (ids: readonly string[]) => { latest = ids }
    const {rerender} = render(<Probe live={['a']} onRender={capture}/>)

    await act(async () => { rerender(<Probe live={['c', 'a']} onRender={capture}/>) })

    expect(latest).toEqual(['a', 'c'])
  })

  it('never removes on merge, so an unresolved query cannot empty the list', async () => {
    // `useBlockQuery` reports [] both while loading and when genuinely empty,
    // and the midnight rollover swaps the query key — so a version that
    // reconciled removals would blank the whole backlog at midnight. Being
    // append-only is what makes that unrepresentable rather than guarded.
    let latest: readonly string[] = []
    const capture = (ids: readonly string[]) => { latest = ids }
    const {rerender} = render(<Probe live={['a', 'b']} onRender={capture}/>)

    await act(async () => { rerender(<Probe live={[]} onRender={capture}/>) })

    expect(latest).toEqual(['a', 'b'])
  })

  it('drops the done ids on reset', async () => {
    let latest: readonly string[] = []
    let reset = () => {}
    const capture = (ids: readonly string[], r: () => void) => { latest = ids; reset = r }
    const {rerender} = render(<Probe live={['a', 'b']} onRender={capture}/>)
    await act(async () => { rerender(<Probe live={['b']} onRender={capture}/>) })
    expect(latest).toEqual(['a', 'b'])

    await act(async () => { reset() })

    expect(latest).toEqual(['b'])
  })
})

describe('backlog page renderer', () => {
  const backlogRenderer = () => {
    const {runtime} = setup()
    const registry = runtime.read(blockRenderersFacet)
    const renderer = registry['readwiseReviewBacklog']
    expect(renderer, 'backlog renderer not registered').toBeDefined()
    return renderer!
  }

  it('claims a block carrying the backlog marker type, and nothing else', async () => {
    const {repo} = setup()
    const snapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      await repo.addTypeInTx(tx, 'page', BACKLOG_TYPE, {}, snapshot)
      await tx.create({id: 'other', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'y'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed pages'})
    await repo.block('page').load()
    await repo.block('other').load()

    const renderer = backlogRenderer()
    const claims = (id: string) =>
      renderer.canRender!({block: repo.block(id)} as BlockRendererProps)

    expect(claims('page')).toBe(true)
    expect(claims('other')).toBe(false)
  })
})
