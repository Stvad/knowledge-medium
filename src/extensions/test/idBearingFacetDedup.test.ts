/**
 * End-to-end dedup check for the real id-bearing render facets through
 * the boundary-aware resolver (#64). The generic `dedupById` machinery is
 * unit-tested in `src/facets/test/facet.test.ts`; this asserts the
 * blessed core facets are actually wired to it (and with the right key
 * scope), so two logically identical contributions can't double-render.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { appMountsFacet, headerItemsFacet } from '@/extensions/core.js'
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
      // The warning names the real facet + colliding key, so it points at
      // the offending mount rather than being a generic "something dup'd".
      expect(warn.mock.calls[0]?.[0]).toContain('core.app-mounts')
      expect(warn.mock.calls[0]?.[0]).toContain('demo.picker')
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

describe('headerItemsFacet — (region, id) dedup', () => {
  it('keeps the same logical id in different regions (no cross-region key collision)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Header.tsx keys each region's list separately, so a `start` and an
      // `end` item sharing an id are NOT a collision — both must survive.
      const runtime = resolveAppRuntimeSync(
        [
          headerItemsFacet.of({ id: 'demo.item', region: 'start', component: Noop }, { source: 'a' }),
          headerItemsFacet.of({ id: 'demo.item', region: 'end', component: Noop }, { source: 'b' }),
        ],
        { overrides: empty },
      )

      const regions = runtime.read(headerItemsFacet)
        .filter(i => i.id === 'demo.item')
        .map(i => i.region)
        .sort()
      expect(regions).toEqual(['end', 'start'])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('collapses a genuine same-region, same-id double-contribution to one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveAppRuntimeSync(
        [
          headerItemsFacet.of({ id: 'demo.item', region: 'end', component: Noop }, { source: 'a' }),
          headerItemsFacet.of({ id: 'demo.item', region: 'end', component: Noop }, { source: 'b' }),
        ],
        { overrides: empty },
      )

      expect(runtime.read(headerItemsFacet).filter(i => i.id === 'demo.item')).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
