// @vitest-environment node
/**
 * The feature gate, which is a module-load decision: whether the plugin
 * contributes anything at all depends on the browser having a directory
 * picker, so each case needs its own module registry.
 */
import {afterEach, describe, expect, it, vi} from 'vitest'

const loadPlugin = async (withPicker: boolean) => {
  vi.resetModules()
  if (withPicker) {
    Object.defineProperty(globalThis, 'showDirectoryPicker', {
      value: async () => { throw new Error('not called') },
      configurable: true,
    })
  } else {
    Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
  }
  return (await import('../index.js')).dbMirrorPlugin
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
})

// Each case re-evaluates the whole plugin module graph (`vi.resetModules()`
// then a fresh import), which pulls in the settings dialog and React. Measured
// at ~6s cold on this machine, so the 5000ms default is not survivable under a
// loaded gate.
describe('the db-mirror plugin', {timeout: 40_000}, () => {
  it('contributes nothing where the browser has no directory picker', async () => {
    // Not "an option that does nothing" — Firefox and Safari users should not
    // see a setting they cannot take.
    expect(await loadPlugin(false)).toBeNull()
  })

  it('contributes a togglable extension where the picker exists', async () => {
    const plugin = await loadPlugin(true)
    const {getBoundary} = await import('@/facets/togglable.js')
    expect(getBoundary(plugin)).toMatchObject({id: 'system:db-mirror', kind: 'system'})
  })

  it('registers its command, its scheduled effect and its health signal', async () => {
    await loadPlugin(true)
    const {resolveFacetRuntimeSync} = await import('@/facets/facet.js')
    const {actionsFacet, appEffectsFacet} = await import('@/extensions/core.js')
    const {diagnosticsFacet} = await import('@/plugins/diagnostics/facet.js')
    const runtime = resolveFacetRuntimeSync([(await import('../index.js')).dbMirrorPlugin])

    expect(runtime.read(actionsFacet).map(a => a.id)).toContain('open_db_mirror_settings')
    expect(runtime.read(appEffectsFacet).map(e => e.id)).toContain('db-mirror.schedule')
    expect([...runtime.read(diagnosticsFacet).values()].map(s => s.id)).toContain('db-mirror')
  })
})
