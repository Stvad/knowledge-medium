import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  DAILY_NOTE_TYPE,
  DATE_SHIFT_BACKWARD_DAY_ACTION_ID,
  DATE_SHIFT_BACKWARD_WEEK_ACTION_ID,
  DATE_SHIFT_FORWARD_DAY_ACTION_ID,
  DATE_SHIFT_FORWARD_WEEK_ACTION_ID,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  dailyNotePickerHeaderItem,
  dailyNotePickerMount,
  dailyNotesPlugin,
  dateShiftQuickActions,
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

  it('contributes a row-3 quick-action set for the date-shift actions plus reschedule', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))
    const items = runtime.read(quickActionItemsFacet)

    expect(items).toEqual(dateShiftQuickActions)
    expect(items.map(item => [item.actionId, item.row, item.label])).toEqual([
      [DATE_SHIFT_BACKWARD_WEEK_ACTION_ID, 3, '-1w'],
      [DATE_SHIFT_BACKWARD_DAY_ACTION_ID, 3, '-1d'],
      [DATE_SHIFT_FORWARD_DAY_ACTION_ID, 3, '+1d'],
      [DATE_SHIFT_FORWARD_WEEK_ACTION_ID, 3, '+1w'],
      [RESCHEDULE_BLOCK_DATE_ACTION_ID, 3, 'Reschedule'],
    ])
  })
})
