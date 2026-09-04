// @vitest-environment happy-dom
//
// The count is read straight off the shared subscribed query — there is no
// cache and no invalidation plumbing to test any more. What IS worth pinning is
// the behaviour that plumbing used to be responsible for: the number tracks
// reviews on its own, the hint appears only on today's note, and the date is
// decided reactively so a note left open across midnight corrects itself.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { ChangeScope } from '@/data/api/index.js'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { RepoContext } from '@/context/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import {
  blockContentDecoratorsFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import type { AppExtension, FacetRuntime } from '@/facets/facet.js'
import { getBlockTypes } from '@/data/properties.js'
import { leftSidebarSectionsFacet } from '@/plugins/left-sidebar/facet.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes/dailyNotes.js'
import { todoActionsExtension, TODO_CYCLE_ACTION_ID } from '@/plugins/todo/actions.js'
import { todoDataExtension } from '@/plugins/todo/dataExtension.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { invokeAction } from '@/shortcuts/actionDispatch.js'
import type {
  ActionConfig, ActionTrigger, BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import type { BlockRenderer } from '@/types.js'

import readwiseContributions from './readwise.tsx'

const HIGHLIGHT_TYPE = 'readwise-highlight'
const REVIEWED_PROP = 'readwise:reviewed'
const REVIEW_DATE_PROP = 'readwise:review_date'
const WS = 'ws-1'

const readwiseDataAndUi = readwiseContributions
  // `'facet' in c` also drops the nested AppExtension arrays (the dialog host),
  // which is what these suites want: they exclude every app mount anyway.
  .filter(c => 'facet' in (c as object)
    && !['core.app-mounts', 'core.app-effects'].includes((c as any).facet.id)) as unknown as AppExtension[]

let sharedDb: TestDb

const setup = () => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    extensions: [
      dailyNotesDataExtension, todoDataExtension, todoActionsExtension, ...readwiseDataAndUi,
    ],
  })
  return {repo, runtime: repo.facetRuntime!}
}

/** An overdue, unreviewed highlight — one row for the count to find. */
const seedOverdueHighlight = async (repo: Repo, id: string) => {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const note = await getOrCreateDailyNote(repo, WS, todayIso(yesterday))
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: `hl ${id}`})
    await repo.addTypeInTx(tx, id, HIGHLIGHT_TYPE, {
      [REVIEW_DATE_PROP]: note.id,
      [REVIEWED_PROP]: false,
    }, snapshot)
  }, {scope: ChangeScope.BlockDefault, description: 'seed overdue'})
  const block = repo.block(id)
  await block.load()
  return block
}

const Inner: BlockRenderer = ({block}) => <span>{block.peek()?.content}</span>

/** Render a daily note through the extension's real content decorators. */
const renderDailyNote = async (
  repo: Repo,
  runtime: FacetRuntime,
  noteId: string,
  {isTopLevel = true}: {isTopLevel?: boolean} = {},
) => {
  const block = repo.block(noteId)
  await block.load()
  const decorate = runtime.read(blockContentDecoratorsFacet)
  const Decorated = decorate(
    {
      block,
      isTopLevel,
      types: [...getBlockTypes(block.peek()!)],
    } as unknown as BlockResolveContext,
    Inner,
  )
  // A FRESH element every time: React bails out of a re-render given the
  // referentially identical element, which would silently skip the effect the
  // rerender helper below exists to re-run.
  const tree = () => (
    <RepoContext.Provider value={repo}>
      <Decorated block={block}/>
    </RepoContext.Provider>
  )
  let result!: ReturnType<typeof render>
  await act(async () => { result = render(tree()) })
  return {
    block,
    /** Re-run the render (and so the count effect) without remounting. */
    rerender: async () => { await act(async () => { result.rerender(tree()) }) },
  }
}

const hint = () => screen.queryByRole('button', {name: /Readwise highlight/})

/** Render the extension's real left-sidebar contribution. Unlike the daily-note
 *  hint it carries no date gate, so it isolates the count's own behaviour. */
const renderSidebarSection = async (repo: Repo, runtime: FacetRuntime) => {
  // The sidebar has no block to read a workspace off — it goes straight to
  // `repo.activeWorkspaceId`, which a test Repo does not pin by default.
  repo.setActiveWorkspaceId(WS)
  const sections = runtime.read(leftSidebarSectionsFacet)
  const section = sections.find(s => s.id === 'readwise.review-backlog')
  expect(section, 'sidebar section not registered').toBeDefined()
  const Section = section!.component
  await act(async () => {
    render(
      <RepoContext.Provider value={repo}>
        <Section closeSidebar={() => {}}/>
      </RepoContext.Provider>,
    )
  })
}

const sidebarEntry = () => screen.queryByRole('button', {name: /Readwise review/})

const press = (runtime: FacetRuntime, block: Block) => {
  const action = getEffectiveActions(runtime).find(it => it.id === TODO_CYCLE_ACTION_ID)
  return invokeAction(runtime, {
    action: action as ActionConfig,
    deps: {block, uiStateBlock: block} as unknown as BaseShortcutDependencies,
    trigger: new CustomEvent('test-press') as ActionTrigger,
  })
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { cleanup() })

describe('daily-note backlog hint', () => {
  it('shows the unreviewed count on today\'s note', async () => {
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())

    await renderDailyNote(repo, runtime, today.id)

    await vi.waitFor(() => { expect(hint()).not.toBeNull() })
    expect(hint()!.textContent).toContain('1 Readwise highlight')
  })

  it('tracks a review with no invalidation plumbing at all', async () => {
    // The whole reason the cache is gone. Nothing tells the count that a
    // highlight was reviewed; it is the same subscribed query, so it just moves.
    const {repo, runtime} = setup()
    const first = await seedOverdueHighlight(repo, 'hl-1')
    await seedOverdueHighlight(repo, 'hl-2')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()!.textContent).toContain('2 Readwise') })

    await act(async () => { await press(runtime, first) })

    expect(first.peek()!.properties[REVIEWED_PROP]).toBe(true)
    await vi.waitFor(() => { expect(hint()!.textContent).toContain('1 Readwise') })
  })

  it('disappears when the last highlight is reviewed', async () => {
    const {repo, runtime} = setup()
    const only = await seedOverdueHighlight(repo, 'hl-1')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })

    await act(async () => { await press(runtime, only) })

    await vi.waitFor(() => { expect(hint()).toBeNull() })
  })

  /** Render today's note until the hint appears, then unmount.
   *
   *  PRECONDITION for every negative case below, and not optional — AGENTS.md
   *  §"four ways a test passes for the wrong reason". The count arrives from a
   *  loader-backed query, so a bare "expect no hint" passes whether the gate
   *  rejected the note or the query simply hadn't resolved; waiting on the
   *  already-loaded note content fences nothing. Priming leaves a resolved
   *  count in the shared handle, so the negative renders read it on their first
   *  render and only the gate can hide the hint.
   *
   *  I had this helper, dropped it when the file was rewritten for the
   *  subscribed count, and reintroduced the exact false negative the doctrine
   *  was written about. */
  const primeCount = async (repo: Repo, runtime: FacetRuntime) => {
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })
    cleanup()
  }

  it('stays off a PAST daily note', async () => {
    // Every past daily note carrying a nag would be noise; the hint is a
    // once-a-day nudge on the page you actually open.
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    await primeCount(repo, runtime)
    const past = await getOrCreateDailyNote(repo, WS, '2026-01-05')

    const {block} = await renderDailyNote(repo, runtime, past.id)

    expect(screen.getByText(block.peek()!.content)).toBeTruthy()
    expect(hint()).toBeNull()
  })

  it('stays off a non-focal mount of today\'s note', async () => {
    // Breadcrumbs, embeds and backlink entries all render the same block; the
    // hint would appear once per occurrence.
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    await primeCount(repo, runtime)
    const today = await getOrCreateDailyNote(repo, WS, todayIso())

    await renderDailyNote(repo, runtime, today.id, {isTopLevel: false})

    expect(screen.getByText(today.peek()!.content)).toBeTruthy()
    expect(hint()).toBeNull()
  })

  it('offers the sidebar entry with the same count', async () => {
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')

    await renderSidebarSection(repo, runtime)

    await vi.waitFor(() => { expect(sidebarEntry()).not.toBeNull() })
    expect(sidebarEntry()!.textContent).toContain('1')
  })

  describe('across midnight', () => {
    // `shouldAdvanceTime` keeps real async (DB work, the query) moving while
    // the timers themselves stay controllable.
    beforeEach(() => { vi.useFakeTimers({shouldAdvanceTime: true}) })
    afterEach(() => { vi.useRealTimers() })

    const rollOver = async () => {
      const after = new Date()
      after.setDate(after.getDate() + 1)
      after.setHours(0, 1, 0, 0)
      vi.setSystemTime(after)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    }

    it('hides the hint on a note left open past midnight', async () => {
      // The date is decided in the component off `useStartOfToday`, not baked
      // into the contribution at resolve time — contributions are never
      // re-resolved as time passes.
      const {repo, runtime} = setup()
      await seedOverdueHighlight(repo, 'hl-1')
      const today = await getOrCreateDailyNote(repo, WS, todayIso())
      await renderDailyNote(repo, runtime, today.id)
      await vi.waitFor(() => { expect(hint()).not.toBeNull() })

      await rollOver()

      expect(hint()).toBeNull()
    })

    it('shows the hint on TOMORROW\'s note once midnight makes it today', async () => {
      // The mirror case, and the reason the gate is purely structural now:
      // a date-derived gate could never let this note mount in time.
      const {repo, runtime} = setup()
      await seedOverdueHighlight(repo, 'hl-1')
      const tomorrowIso = todayIso(new Date(Date.now() + 24 * 60 * 60 * 1000))
      const tomorrow = await getOrCreateDailyNote(repo, WS, tomorrowIso)

      // Prime on today's note first, so the pre-rollover assertion below is the
      // date check and not an unresolved query.
      await renderDailyNote(repo, runtime, await getOrCreateDailyNote(repo, WS, todayIso()).then(b => b.id))
      await vi.waitFor(() => { expect(hint()).not.toBeNull() })
      cleanup()

      await renderDailyNote(repo, runtime, tomorrow.id)
      expect(screen.getByText(tomorrow.peek()!.content)).toBeTruthy()
      expect(hint()).toBeNull()

      await rollOver()

      await vi.waitFor(() => { expect(hint()).not.toBeNull() })
    })
  })
})
