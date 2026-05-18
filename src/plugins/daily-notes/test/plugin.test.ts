import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  DAILY_NOTE_TYPE,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  SPREAD_BLOCK_DATES_ACTION_ID,
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

  it('contributes spread-dates in both NORMAL_MODE and MULTI_SELECT_MODE plus the grouped-backlinks entry', () => {
    const fakeRepo = {} as Parameters<typeof dailyNotesPlugin>[0]['repo']
    const runtime = resolveFacetRuntimeSync(dailyNotesPlugin({repo: fakeRepo}))

    const spreadActions = runtime
      .read(actionsFacet)
      .filter(a => a.id === SPREAD_BLOCK_DATES_ACTION_ID)
    expect(spreadActions.map(a => a.context).sort()).toEqual([
      ActionContextTypes.MULTI_SELECT_MODE,
      ActionContextTypes.NORMAL_MODE,
    ].sort())

    const entries = runtime.read(groupedBacklinksGroupHeaderActionsFacet)
    expect(entries.map(e => e.actionId)).toContain(SPREAD_BLOCK_DATES_ACTION_ID)
  })
})
