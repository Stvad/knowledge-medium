import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import { DAILY_NOTE_TYPE, dailyNotesPlugin } from '../index.ts'

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
})
