/** The extension's wiring.
 *
 *  `src/index.ts` itself cannot be imported under this tier: it calls
 *  `@/extensions/core.js`, `@/data/facets.js` and
 *  `@/extensions/dialogAppMount.js` directly, and none of the five existing
 *  kernel fakes (`test/kernel/*.ts`, aliased in `vitest.config.ts`) cover
 *  those paths — they resolve to the declaration-only kernel-type stubs,
 *  which have no runtime. `vi.mock` cannot stand in for them either
 *  (verified directly: mocking `'@/extensions/core.js'` and then importing
 *  it still throws "Cannot find package", because the generic `@/(.*)`
 *  alias resolves the specifier to a non-existent `kernel-types/src/...js`
 *  path before Vitest's mock registry gets a chance to substitute it — the
 *  same reason every OTHER aliased path here is a real file, not a bare
 *  `vi.mock`). Extending `vitest.config.ts` with new aliases (the fix that
 *  would make `src/index.ts` importable, mirroring the five existing
 *  entries) is outside this task's file scope, so it is not done here.
 *
 *  What IS verified: `./ui/actions`, the one module `src/index.ts` composes
 *  that has no such blocker once its own km dependencies are mocked (same
 *  reason `test/startAction.test.ts` mocks every `km/*` module
 *  `startAction.ts` touches) — this pins the five action ids/descriptions
 *  for real. The rest of the wiring (every seed reaching
 *  `definitionSeedsFacet`/`typeSeedsFacet`, the renderer reaching
 *  `blockRenderersFacet`, `dialogAppMountExtension` being mounted) is
 *  covered by `pnpm run typecheck` — the `.of()` calls type-check against
 *  the REAL facet API from the kernel-type stubs — and by mirroring the
 *  Strength Tracker's `src/index.ts` shape line for line.
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('../src/km/experiment', () => ({stampNight: vi.fn(), createExperimentAt: vi.fn()}))
vi.mock('../src/km/page', () => ({findLabPage: vi.fn(), getOrCreateLabPage: vi.fn()}))
vi.mock('../src/km/nights', () => ({importSessions: vi.fn()}))

const {
  openLabAction, tonightAction, lastNightAction, importAction, startExperimentHereAction,
} = await import('../src/ui/actions')

describe('the five documented actions', () => {
  const globalActions = [openLabAction, tonightAction, lastNightAction, importAction]
  const actions = [...globalActions, startExperimentHereAction]

  it('carries the ids the README and PROTOCOL.md promise', () => {
    expect(actions.map(a => a.id).sort()).toEqual([
      'sleeplab.import', 'sleeplab.lastNight', 'sleeplab.open', 'sleeplab.startExperiment', 'sleeplab.tonight',
    ])
  })

  it('describes each one as the README lists it', () => {
    const byId = new Map(actions.map(a => [a.id, a.description]))
    expect(byId.get('sleeplab.open')).toBe('Sleep Lab: open')
    expect(byId.get('sleeplab.tonight')).toBe('Sleep Lab: tonight')
    expect(byId.get('sleeplab.lastNight')).toBe('Sleep Lab: last night')
    expect(byId.get('sleeplab.import')).toBe('Sleep Lab: import watch data')
    expect(byId.get('sleeplab.startExperiment')).toBe('Sleep Lab: start an experiment here')
  })

  it('registers the four dashboard commands under GLOBAL', () => {
    expect(globalActions.every(a => a.context === 'global')).toBe(true)
  })

  it('registers "start an experiment here" under NORMAL_MODE, since the block you are on is its argument', () => {
    expect(startExperimentHereAction.context).toBe('normal-mode')
  })

  it('has no duplicate ids', () => {
    expect(new Set(actions.map(a => a.id)).size).toBe(actions.length)
  })
})
