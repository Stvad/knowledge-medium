import { describe, expect, it } from 'vitest'
import { actionsFacet, headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { typesFacet } from '@/data/facets.js'
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
    // The Repo's plugin data ownership is resolved from the single
    // `staticAppExtensions` tree (in bootstrapWorkspace, then
    // AppRuntimeProvider). Plugins (todo, backlinks, srs-rescheduling,
    // daily-notes) bundle their dataExtension into the *Plugin factory
    // output for exactly this reason — without that, the daily-note type
    // would be absent and any later getOrCreateDailyNote /
    // ensureDailyNoteTarget throws on addTypeInTx.
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))
    const types = runtime.read(typesFacet)

    expect(types.has(DAILY_NOTE_TYPE)).toBe(true)
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
