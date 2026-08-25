// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import {
  applyLocalSchemaContributions,
  installedAnalyzeArmingProbes,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { referencesLocalSchema } from '@/plugins/references/localSchema.js'

const runAnalyzeIfStale = vi.hoisted(() => vi.fn(async () => ({proposed: []})))
vi.mock('@/data/maintenance', () => ({runAnalyzeIfStale}))
// Run the idle callback inline so the assertion does not race a real idle frame.
vi.mock('@/utils/scheduleIdle.js', () => ({
  CATCHUP_DEEP_IDLE: 'catchup',
  scheduleDeepIdle: (fn: () => void) => { fn() },
}))

const { scheduleImportAnalyze } = await import('../action.ts')

describe('scheduleImportAnalyze', () => {
  beforeEach(() => { runAnalyzeIfStale.mockClear() })

  it('arms the tables the INSTALLED schema owns, not just the core ones', async () => {
    // The regression this pins: reading the probes off `repo.facetRuntime`
    // instead. That is toggle-filtered, so with References disabled it drops
    // `block_references` — while `staticDataExtensions` installs that table and
    // its triggers regardless, and the importer keeps filling it. The result is
    // a large reference index quietly keeping bad statistics, with no error.
    //
    // Invisible from the action's behaviour, which is why it is asserted on the
    // ARGUMENT rather than on an outcome: both sources return a plausible
    // non-empty probe list, and only one of them matches the installed schema.
    const db = {
      execute: async () => {},
      getOptional: async () => null,
    }
    await applyLocalSchemaContributions(db, resolveLocalSchemaContributions(staticDataExtensions))

    scheduleImportAnalyze({db: {}} as unknown as Repo)

    expect(runAnalyzeIfStale).toHaveBeenCalledTimes(1)
    const probes = runAnalyzeIfStale.mock.calls[0][1] as readonly string[]
    expect(probes).toEqual([...installedAnalyzeArmingProbes()])
    // Named explicitly: `installedAnalyzeArmingProbes()` alone would still pass
    // if it silently fell back to the core probes.
    expect(probes).toEqual(
      expect.arrayContaining((referencesLocalSchema.analyzeTables ?? []).map(t => t.probe)),
    )
  })
})
