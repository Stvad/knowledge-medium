// @vitest-environment node
/**
 * Wiring. The two things that must be true of the composition itself:
 * the whole feature really is inside the toggle boundary, and the data half
 * is present in the pre-React bootstrap runtime (or the record type would not
 * resolve when the processor first fires).
 */

import { describe, expect, it } from 'vitest'
import { postCommitProcessorsFacet, typeSeedsFacet } from '@/data/facets.js'
import { appEffectsFacet } from '@/extensions/core.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { archiveServicesFacet, WAYBACK_SERVICE_ID } from '../service.ts'
import { ARCHIVE_SNAPSHOT_TYPE } from '../schema.ts'
import { archiveServiceIdProp, archiveEnabledProp } from '../prefs.ts'
import { webArchivePlugin } from '../index.ts'

const PROCESSOR = 'web-archive.notice'
const DRAIN_EFFECT = 'web-archive.drain'

describe('webArchivePlugin', () => {
  it('registers the notice processor and the drain effect when enabled', () => {
    const runtime = resolveAppRuntimeSync([webArchivePlugin], {overrides: new Map()})
    expect([...runtime.read(postCommitProcessorsFacet).keys()]).toContain(PROCESSOR)
    expect(runtime.read(appEffectsFacet).map(e => e.id)).toContain(DRAIN_EFFECT)
  })

  // Disabling the plugin has to remove the machinery, not just the UI — a
  // processor left running with the toggle off would keep writing records.
  it('drops both when the plugin is toggled off', () => {
    const runtime = resolveAppRuntimeSync([webArchivePlugin], {
      overrides: new Map([['system:web-archive', false]]),
    })
    expect([...runtime.read(postCommitProcessorsFacet).keys()]).not.toContain(PROCESSOR)
    expect(runtime.read(appEffectsFacet).map(e => e.id)).not.toContain(DRAIN_EFFECT)
  })

  it('ships exactly one archive service, and it is the Wayback one', () => {
    const services = resolveFacetRuntimeSync([webArchivePlugin]).read(archiveServicesFacet)
    expect([...services.keys()]).toEqual([WAYBACK_SERVICE_ID])
  })

  // The default has to name a service that is actually registered, or the
  // feature is inert for anyone who opts in without touching anything else.
  it('defaults `serviceId` to a registered service', () => {
    const services = resolveFacetRuntimeSync([webArchivePlugin]).read(archiveServicesFacet)
    expect(services.has(archiveServiceIdProp.defaultValue)).toBe(true)
  })

  it('is off by default at the schema level', () => {
    expect(archiveEnabledProp.defaultValue).toBe(false)
  })
})

describe('staticDataExtensions', () => {
  // The processor fires during bootstrap writes, before React mounts. If the
  // record type only existed in the app runtime, the first `addTypeInTx`
  // would have nothing to resolve.
  it('carries the record type and the processor pre-React', () => {
    const runtime = resolveFacetRuntimeSync(staticDataExtensions)
    expect(runtime.read(typeSeedsFacet).map(t => t.id)).toContain(ARCHIVE_SNAPSHOT_TYPE)
    expect([...runtime.read(postCommitProcessorsFacet).keys()]).toContain(PROCESSOR)
  })
})
