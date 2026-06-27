// @vitest-environment jsdom
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
import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'

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

    // The plugins actually flowed into the runtime: core facets are non-empty.
    expect(runtime.read(actionsFacet).length).toBeGreaterThan(0)
    expect(runtime.read(appMountsFacet).length).toBeGreaterThan(0)
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
