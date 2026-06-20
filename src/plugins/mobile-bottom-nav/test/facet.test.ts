import { describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { mobileBottomNavItemsFacet } from '../facet.ts'

// MobileBottomNav.tsx renders one button per item keyed by `id`, so a
// duplicate logical id would double-mount + collide on the React key. Pin
// the dedup wiring, and that it keys on `id` not `actionId` (#64).
describe('mobileBottomNavItemsFacet — id dedup', () => {
  it('collapses two distinct contributions sharing an id to a single item', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveFacetRuntimeSync([
        // Different actionIds — only the shared `id` collides.
        mobileBottomNavItemsFacet.of({ id: 'demo.item', actionId: 'undo' }, { source: 'a' }),
        mobileBottomNavItemsFacet.of({ id: 'demo.item', actionId: 'redo' }, { source: 'b' }),
      ])

      expect(
        runtime.read(mobileBottomNavItemsFacet).filter(i => i.id === 'demo.item'),
      ).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
