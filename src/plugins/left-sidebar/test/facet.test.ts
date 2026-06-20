import { describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { leftSidebarSectionsFacet, type LeftSidebarSectionProps } from '../facet.ts'

const Section: ComponentType<LeftSidebarSectionProps> = () => null

// LeftSidebar.tsx renders one `<ExtensionRenderBoundary key={id}>` per
// section, so a duplicate logical id would double-mount + collide on the
// React key. Pin the dedup wiring (#64).
describe('leftSidebarSectionsFacet — id dedup', () => {
  it('collapses two distinct contributions sharing an id to a single section', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveFacetRuntimeSync([
        leftSidebarSectionsFacet.of({ id: 'demo.section', component: Section }, { source: 'a' }),
        leftSidebarSectionsFacet.of({ id: 'demo.section', component: Section }, { source: 'b' }),
      ])

      expect(
        runtime.read(leftSidebarSectionsFacet).filter(s => s.id === 'demo.section'),
      ).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
