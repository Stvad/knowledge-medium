import { describe, expect, it } from 'vitest'
import { actionContextsFacet, actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { typesFacet } from '@/data/facets.js'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  DAILY_NOTE_TYPE,
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_FORWARD_DAY_ACTION_ID,
  EDIT_MODE_START_DATE_SCRUB_ACTION_ID,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  START_DATE_SCRUB_ACTION_ID,
  SPREAD_BLOCK_DATES_ACTION_ID,
  SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID,
  dailyNotePickerHeaderItem,
  dailyNotePickerMount,
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
    const types = runtime.read(typesFacet)

    expect(types.has(DAILY_NOTE_TYPE)).toBe(true)
  })

  it('contributes the daily note picker mount, action, and header item', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))

    expect(runtime.read(appMountsFacet)).toContain(dailyNotePickerMount)
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

  it('contributes date scrub start actions and modal movement context', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))

    const context = runtime.read(actionContextsFacet).find(candidate =>
      candidate.type === DATE_SCRUB_CONTEXT)
    expect(context?.exclusive).toBe(true)

    const actions = runtime.read(actionsFacet)
    expect(actions.find(action => action.id === START_DATE_SCRUB_ACTION_ID)?.context)
      .toBe(ActionContextTypes.NORMAL_MODE)
    expect(actions.find(action => action.id === EDIT_MODE_START_DATE_SCRUB_ACTION_ID)?.context)
      .toBe(ActionContextTypes.EDIT_MODE_CM)
    expect(actions.find(action => action.id === DATE_SCRUB_FORWARD_DAY_ACTION_ID)?.context)
      .toBe(DATE_SCRUB_CONTEXT)
  })
})
