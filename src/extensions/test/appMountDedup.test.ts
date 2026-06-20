/**
 * End-to-end dedup check for the real `appMountsFacet` through the
 * boundary-aware resolver (#64). The generic `dedupById` machinery is
 * unit-tested in `src/facets/test/facet.test.ts`; this asserts the
 * blessed core mount facet is actually wired to it, so two logically
 * identical mounts can't double-render.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { appMountsFacet } from '@/extensions/core.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import type { Overrides } from '@/facets/togglable.js'

const empty: Overrides = new Map()
const Noop: ComponentType = () => null

describe('appMountsFacet — id dedup', () => {
  it('collapses two distinct contributions of the same mount id to a single mount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Two SEPARATE contributions (fresh objects, as minted inside
      // plugin factories) carrying the same logical id — the resolver's
      // reference dedup can't catch these, so without an id-keyed combine
      // both would render.
      const runtime = resolveAppRuntimeSync(
        [
          appMountsFacet.of({ id: 'demo.picker', component: Noop }, { source: 'a' }),
          appMountsFacet.of({ id: 'demo.picker', component: Noop }, { source: 'b' }),
        ],
        { overrides: empty },
      )

      expect(runtime.read(appMountsFacet).filter(m => m.id === 'demo.picker')).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves a single contribution unchanged without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveAppRuntimeSync(
        [appMountsFacet.of({ id: 'demo.solo', component: Noop }, { source: 'a' })],
        { overrides: empty },
      )

      expect(runtime.read(appMountsFacet).map(m => m.id)).toEqual(['demo.solo'])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
