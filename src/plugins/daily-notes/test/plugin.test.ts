import { describe, expect, it } from 'vitest'
import {
  blockContentDecoratorsFacet,
  type BlockContentDecoratorContribution,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import { actionsFacet, headerItemsFacet } from '@/extensions/core.js'
import type { BlockRenderer } from '@/types.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { typeSeedsFacet } from '@/data/facets.js'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  DAILY_NOTE_TYPE,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  SPREAD_BLOCK_DATES_ACTION_ID,
  SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID,
  dailyNotePickerHeaderItem,
  dailyNotesPlugin,
  openDailyNotePickerAction,
} from '../index.ts'

describe('dailyNotesPlugin', () => {
  it('contributes the daily-note TypeContribution through the app-side plugin', () => {
    // AppRuntimeProvider rebuilds the FacetRuntime from
    // `staticAppExtensions` alone (NOT staticDataExtensions) and then
    // `repo.setFacetRuntime(...)` REPLACES the kernel/bootstrap
    // registries. Other plugins (todo, backlinks, srs-rescheduling)
    // bundle their dataExtension into the *Plugin factory output for
    // exactly this reason — without that, the daily-note type
    // disappears post-mount and any later getOrCreateDailyNote /
    // ensureDailyNoteTarget throws on addTypeInTx.
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))
    const types = runtime.read(typeSeedsFacet)

    expect(types.some(t => t.id === DAILY_NOTE_TYPE)).toBe(true)
  })

  it('contributes the daily note picker action and header item', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))

    expect(runtime.read(headerItemsFacet)).toContain(dailyNotePickerHeaderItem)

    const actions = runtime.read(actionsFacet)
    const pickerAction = actions.find(action => action.id === OPEN_DAILY_NOTE_PICKER_ACTION_ID)
    expect(pickerAction).toBeTruthy()
    expect(openDailyNotePickerAction({repo: fakeRepo}).id).toBe(OPEN_DAILY_NOTE_PICKER_ACTION_ID)
  })

  it('contributes the title date-nav arrows as a content decorator', () => {
    // Registration is the only thing DateNavDecorator.test.tsx can't see (it
    // drives the contribution directly) — without this the arrows are dead
    // code and nothing else fails.
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))
    const decorateContent = runtime.read(blockContentDecoratorsFacet)
    const inner: BlockRenderer = () => null

    expect(decorateContent({isTopLevel: true, blockContext: {}} as BlockResolveContext, inner))
      .not.toBe(inner)
    expect(decorateContent({isTopLevel: false, blockContext: {}} as BlockResolveContext, inner))
      .toBe(inner)
  })

  it('wraps closer to the text than a decorator that stacks chrome below it', () => {
    // A decorator that stacks chrome below the content (the readwise backlog
    // hint) must not land inside the arrows' row, where it gets indented behind
    // the left arrow instead of starting at the block's edge. The stacking
    // decorator is registered FIRST here, so at equal precedence registration
    // order would make it the innermost one — only date-nav's explicit negative
    // precedence keeps it inside.
    const stacking: BlockContentDecoratorContribution = () => inner => {
      const Decorated: BlockRenderer = () => null
      Decorated.displayName = `Stacking(${(inner as {displayName?: string}).displayName ?? 'inner'})`
      return Decorated
    }
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync([
      blockContentDecoratorsFacet.of(stacking, {source: 'test'}),
      dailyNotesPlugin({repo: fakeRepo}),
    ])
    const inner: BlockRenderer = () => null

    const outermost = runtime.read(blockContentDecoratorsFacet)(
      {isTopLevel: true, blockContext: {}} as BlockResolveContext,
      inner,
    )

    expect((outermost as {displayName?: string}).displayName).toBe('Stacking(WithDateNav)')
  })

  it('contributes the Reschedule quick action on the primary row', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))
    const items = runtime.read(quickActionItemsFacet)

    expect(items.map(item => [item.actionId, item.row, item.label])).toEqual([
      [RESCHEDULE_BLOCK_DATE_ACTION_ID, undefined, 'Reschedule'],
    ])
  })

  it('contributes spread-dates in both NORMAL_MODE and MULTI_SELECT_MODE under distinct ids', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))

    const actions = runtime.read(actionsFacet)
    const blockAction = actions.find(a => a.id === SPREAD_BLOCK_DATES_ACTION_ID)
    const blocksAction = actions.find(a => a.id === SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID)
    expect(blockAction?.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(blocksAction?.context).toBe(ActionContextTypes.MULTI_SELECT_MODE)

    const entries = runtime.read(groupedBacklinksGroupHeaderActionsFacet)
    expect(entries.map(e => e.actionId)).toContain(SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID)
  })
})
