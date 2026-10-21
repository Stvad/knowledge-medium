import { describe, expect, it, vi } from 'vitest'

// Pins that importing describeRuntime does NOT evaluate the authoring catalog:
// the catalog is ~1 MB built and belongs to the describe commands, not to the
// boot graph. A factory-backed mock records the first evaluation.
const evaluated = vi.hoisted(() => ({ catalog: 0 }))
vi.mock('../authoringCatalog.ts', () => {
  evaluated.catalog++
  return { describeAuthoringCatalog: () => ({ guides: [], modules: [], components: [] }) }
})

describe('authoring catalog loading', () => {
  it('stays out of the module graph until a describe command runs', async () => {
    const mod = await import('../describeRuntime.ts')
    expect(evaluated.catalog).toBe(0)
    expect(typeof mod.describeRuntime).toBe('function')
  })
})
