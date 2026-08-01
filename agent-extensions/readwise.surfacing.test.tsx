// @vitest-environment happy-dom
//
// The daily-note backlog hint rides along on a page opened constantly, so the
// requirement is as much about what it must NOT do as what it shows: no live
// subscription, one query per TTL window, and a refetch only when the latch
// actually changes the count. Every assertion below is on the real
// `repo.queryBlocks` call count, not on rendered text alone — rendered text
// would look identical whether the count was cached or re-fetched per render.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { ChangeScope } from '@/data/api/index.js'
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

import readwiseContributions, { invalidateBacklogCount } from './readwise.tsx'

const HIGHLIGHT_TYPE = 'readwise-highlight'
const REVIEWED_PROP = 'readwise:reviewed'
const REVIEW_DATE_PROP = 'readwise:review_date'
const WS = 'ws-1'

const readwiseDataAndUi = readwiseContributions
  .filter(c => !['core.app-mounts', 'core.app-effects'].includes(c.facet.id)) as unknown as AppExtension[]

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
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  // The count cache is module-level and outlives a test.
  invalidateBacklogCount()
})
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

  /** Render today's note until the hint appears, then unmount.
   *
   *  This is the PRECONDITION for every negative case below, and it is not
   *  optional: the count arrives asynchronously, so a bare "expect no hint" on
   *  a freshly-rendered note passes whether the gate rejected the note or the
   *  fetch simply hadn't landed yet. Priming leaves a non-null count in the
   *  module cache (well inside its TTL), so the negative renders read it
   *  synchronously on their first render and only the gate can hide the hint. */
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

    // The note itself renders — this isn't an empty tree that trivially has no
    // hint in it.
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

  it('does not re-query when an unrelated highlight is written', async () => {
    // THE requirement: no live subscription. A subscribed typed-block query
    // here would re-resolve on every write touching a highlight.
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    await seedOverdueHighlight(repo, 'hl-2')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })

    const queryBlocks = vi.spyOn(repo, 'queryBlocks')
    await act(async () => {
      await repo.tx(async tx => {
        await tx.update('hl-2', {content: 'edited highlight text'})
      }, {scope: ChangeScope.BlockDefault, description: 'edit a highlight'})
    })

    expect(queryBlocks).not.toHaveBeenCalled()
    // Fence: the count IS refetchable — so the assertion above is about the
    // absent subscription, not about a wedged cache.
    await act(async () => { invalidateBacklogCount() })
    await vi.waitFor(() => { expect(queryBlocks).toHaveBeenCalled() })
  })

  it('refetches after the review latch marks a highlight, without a subscription', async () => {
    // The cache is only correct because `markHighlightReviewed` invalidates it.
    // Drive the REAL keypress rather than calling the invalidate helper, so a
    // future refactor that drops that call fails here.
    const {repo, runtime} = setup()
    const highlight = await seedOverdueHighlight(repo, 'hl-1')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()!.textContent).toContain('1 Readwise highlight') })

    await act(async () => { await press(runtime, highlight) })

    expect(highlight.peek()!.properties[REVIEWED_PROP]).toBe(true)
    await vi.waitFor(() => { expect(hint()).toBeNull() })
  })

  it('gives up for the rest of the window when the count query fails', async () => {
    // Found by mutation: the refresh is driven from an effect with no
    // dependency array, and every settled fetch notifies subscribers. If the
    // guard were on the cached VALUE's age, a persistently failing query would
    // leave the cache empty and spin — settle, notify, render, fetch — hard
    // enough to take the test worker down with it. Gating on the last ATTEMPT
    // bounds it to one try per window whatever the outcome.
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    const queryBlocks = vi.spyOn(repo, 'queryBlocks')
      .mockRejectedValue(new Error('db is having a moment'))

    const {rerender} = await renderDailyNote(repo, runtime, today.id)
    // Each render runs the effect that calls refresh, so this is the spin
    // played out deterministically rather than waited for.
    for (let i = 0; i < 5; i++) await rerender()

    expect(queryBlocks).toHaveBeenCalledTimes(1)
    expect(hint()).toBeNull()
  })

  describe('across midnight', () => {
    // `shouldAdvanceTime` keeps real async (DB work, the count fetch) moving
    // while the timers themselves are controllable.
    beforeEach(() => { vi.useFakeTimers({shouldAdvanceTime: true}) })
    afterEach(() => { vi.useRealTimers() })

    it('hides the hint on a note left open past midnight', async () => {
      // The contribution's today-check runs once, when the decorator set is
      // resolved — so the component has to re-check the date itself, or an
      // open note keeps a hint that now belongs on a different page.
      const {repo, runtime} = setup()
      await seedOverdueHighlight(repo, 'hl-1')
      const today = await getOrCreateDailyNote(repo, WS, todayIso())
      await renderDailyNote(repo, runtime, today.id)
      await vi.waitFor(() => { expect(hint()).not.toBeNull() })

      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(0, 1, 0, 0)
      vi.setSystemTime(tomorrow)
      // Let the shared rollover ticker notice the new calendar day.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

      expect(hint()).toBeNull()
    })
  })

  it('serves several consumers from ONE query', async () => {
    const {repo, runtime} = setup()
    await seedOverdueHighlight(repo, 'hl-1')
    const today = await getOrCreateDailyNote(repo, WS, todayIso())
    const queryBlocks = vi.spyOn(repo, 'queryBlocks')

    await renderDailyNote(repo, runtime, today.id)
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })

    expect(queryBlocks).toHaveBeenCalledTimes(1)
  })
})
