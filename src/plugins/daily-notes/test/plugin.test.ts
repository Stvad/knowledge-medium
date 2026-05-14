import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import {
  DAILY_NOTE_TYPE,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
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
    expect(runtime.read(actionsFacet)).toContain(openDailyNotePickerAction)
    expect(openDailyNotePickerAction.id).toBe(OPEN_DAILY_NOTE_PICKER_ACTION_ID)
  })
})
