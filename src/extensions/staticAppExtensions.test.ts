// @vitest-environment happy-dom
//
// Boot-composition smoke test. The full provider+plugin tree is never mounted
// by the unit suite (App.tsx is bound to the live PowerSync boot), so a plugin
// that throws on import, contributes a malformed facet, or collides on
// registration would slip past the gate and only surface as a blank screen at
// runtime. This composes the REAL production plugin set
// (`staticAppExtensions`) through the same resolver `AppRuntimeProvider` uses
// and asserts it both succeeds and actually produces contributions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { localSchemaFacet, sameTxProcessorsFacet } from '@/data/facets.js'
import { resolveAnalyzeArmingProbes } from '@/data/localSchema.js'
import { referencesLocalSchema } from '@/plugins/references/localSchema.js'
import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { ALIAS_SYNC_PROCESSOR } from '@/plugins/alias'
import { RENAME_BACKLINKS_PROCESSOR } from '@/plugins/references/renameProcessor.js'

let shared: TestDb
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })

describe('app boot composition', () => {
  it('composes the full production plugin set into a runtime that has contributions', () => {
    const { repo } = createTestRepo({ db: shared.db })
    const extensions = staticAppExtensions({ repo })
    // Sanity: this is the real, full plugin list, not a trimmed fixture.
    expect(extensions.length).toBeGreaterThan(40)

    const runtime = resolveAppRuntimeSync(extensions, { overrides: new Map(), safeMode: false })

    // The plugins actually flowed into the runtime. These floors are a
    // mass-drop-out tripwire, not an exact count: the full set yields ~136
    // actions and ~12 app mounts, so a regression where many plugins silently
    // stop contributing (without throwing) trips this. Bump the floors if you
    // legitimately remove enough plugins to fall below them.
    expect(runtime.read(actionsFacet).length).toBeGreaterThan(100)
    expect(runtime.read(appMountsFacet).length).toBeGreaterThan(8)
  })

  // Same-tx processors run in facet INSERTION order, so a plugin-list
  // reorder is a semantic change, not cosmetic. `references.renameBacklinks`
  // reacts to the alias diff that `alias.sync` writes when a page title is
  // edited (the ordinary rename gesture): ahead of sync there is no diff
  // yet and the rename silently never fires — no error, no failing
  // processor, just backlinks that stop following renames. Nothing else in
  // the app would notice, which is why this is pinned here against the
  // REAL production list rather than left to the processors' own tests.
  // See the ORDERING note in `plugins/references/renameProcessor.ts`.
  it('orders alias.sync before references.renameBacklinks', () => {
    const { repo } = createTestRepo({ db: shared.db })
    const runtime = resolveAppRuntimeSync(staticAppExtensions({ repo }), {
      overrides: new Map(), safeMode: false,
    })
    const order = [...runtime.read(sameTxProcessorsFacet).keys()]
    expect(order).toContain(ALIAS_SYNC_PROCESSOR)
    expect(order).toContain(RENAME_BACKLINKS_PROCESSOR)
    expect(order.indexOf(ALIAS_SYNC_PROCESSOR))
      .toBeLessThan(order.indexOf(RENAME_BACKLINKS_PROCESSOR))
  })

  // `roam-import` reads the ANALYZE arming probes off `repo.facetRuntime` at
  // action-handler time, and by then AppRuntimeProvider has REPLACED the
  // data-only runtime installed at repo construction with this one. If the app
  // runtime stopped carrying `localSchemaFacet` the read would come back empty
  // and the import would silently fall back to the core probes — leaving
  // `block_references` unarmed on the one pass that grows it most. There is no
  // error in that failure, so it is pinned here rather than left to the read.
  // The `repo.facetRuntime` docstring names this same contract.
  it('carries the local-schema contributions, so non-React facet reads see them', () => {
    const { repo } = createTestRepo({ db: shared.db })
    const runtime = resolveAppRuntimeSync(staticAppExtensions({ repo }), {
      overrides: new Map(), safeMode: false,
    })
    const contributed = [...(referencesLocalSchema.analyzeProbes ?? [])]
    expect(contributed).not.toHaveLength(0)
    expect(resolveAnalyzeArmingProbes(runtime.read(localSchemaFacet)))
      .toEqual(expect.arrayContaining(contributed))
  })

  it('still composes in safe mode (degraded-boot path)', () => {
    const { repo } = createTestRepo({ db: shared.db })
    const runtime = resolveAppRuntimeSync(staticAppExtensions({ repo }), {
      overrides: new Map(),
      safeMode: true,
    })
    expect(runtime).toBeTruthy()
  })
})
