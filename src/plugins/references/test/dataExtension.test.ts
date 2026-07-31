// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import {
  invalidationRulesFacet,
  localSchemaFacet,
  sameTxProcessorsFacet,
} from '@/data/facets.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { ALIAS_SYNC_PROCESSOR } from '@/plugins/alias'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { referencesDataExtension } from '../dataExtension.ts'
import { referencesPlugin } from '../index.ts'
import { referencesInvalidationRule } from '../invalidation.ts'
import { referencesLocalSchema } from '../localSchema.ts'
import { RENAME_BACKLINKS_PROCESSOR } from '../renameProcessor.ts'

describe('referencesDataExtension', () => {
  it('contributes the local reference edge index schema', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(localSchemaFacet)).toEqual([referencesLocalSchema])
  })

  it('contributes reference invalidation', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(invalidationRulesFacet)).toEqual([referencesInvalidationRule])
  })

  // The rename rewriter has to run after `alias.sync`, which lives in a
  // DIFFERENT extension. It gets there by precedence, so it stays inside
  // this extension — and therefore inside the references plugin's
  // `systemToggle` boundary, which is what makes disabling References
  // actually stop it (Codex on PR #444: a bare contribution placed by hand
  // in the composition roots kept rewriting spans and invalidating edges
  // with `parseReferences` gone).
  it('keeps the rename rewriter inside the plugin extension', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect([...runtime.read(sameTxProcessorsFacet).keys()])
      .toContain(RENAME_BACKLINKS_PROCESSOR)
  })

  it('drops the rename rewriter when the References plugin is toggled off', () => {
    const off = resolveAppRuntimeSync([referencesPlugin], {
      overrides: new Map([['system:references', false]]),
    })
    const names = [...off.read(sameTxProcessorsFacet).keys()]
    expect(names).not.toContain(RENAME_BACKLINKS_PROCESSOR)
    // Sanity: the toggle id is right and the plugin really does contribute
    // it when enabled — otherwise this passes for the wrong reason.
    const on = resolveAppRuntimeSync([referencesPlugin], {overrides: new Map()})
    expect([...on.read(sameTxProcessorsFacet).keys()])
      .toContain(RENAME_BACKLINKS_PROCESSOR)
  })
})

describe('staticDataExtensions (pre-React bootstrap runtime)', () => {
  // Second runtime: `staticDataExtensions` is what the Repo is constructed
  // with, before any React runtime resolves, so the ordering invariant has
  // to hold here independently of the app runtime.
  it('orders alias.sync before references.renameBacklinks', () => {
    const order = [
      ...resolveFacetRuntimeSync(staticDataExtensions).read(sameTxProcessorsFacet).keys(),
    ]
    expect(order).toContain(ALIAS_SYNC_PROCESSOR)
    expect(order.indexOf(ALIAS_SYNC_PROCESSOR))
      .toBeLessThan(order.indexOf(RENAME_BACKLINKS_PROCESSOR))
  })

  // The ordering does NOT come from where the two extensions sit in the
  // list — `referencesDataExtension` is registered BEFORE
  // `aliasDataExtension` there, so registration order alone would put
  // rename first. Asserted so a future reader doesn't "simplify" the
  // precedence away on the assumption that position already handles it.
  it('gets that order from precedence, not from list position', () => {
    const sources = staticDataExtensions.map(e => e)
    expect(sources.indexOf(referencesDataExtension))
      .toBeLessThan(sources.indexOf(aliasDataExtension))
  })
})

describe('referencesPlugin', () => {
  it('owns reference markdown syntax and CodeMirror completions', () => {
    const runtime = resolveFacetRuntimeSync(referencesPlugin)

    expect(runtime.contributions(markdownExtensionsFacet).map(c => c.source)).toEqual([
      'references',
      'references',
    ])
    expect(runtime.contributions(codeMirrorExtensionsFacet).map(c => c.source)).toEqual(['references'])
  })
})
