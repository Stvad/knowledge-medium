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
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { ALIAS_SYNC_PROCESSOR } from '@/plugins/alias'
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

  // The rename rewriter is deliberately NOT in this extension — it has to
  // be insertable after the alias plugin. Assert the split so folding it
  // back in (the obvious "tidy-up") fails loudly here rather than silently
  // stopping renames from cascading. `staticAppExtensions.test.ts` pins the
  // resulting order in the live app runtime.
  it('leaves the rename rewriter out, for ordering', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect([...runtime.read(sameTxProcessorsFacet).keys()])
      .not.toContain(RENAME_BACKLINKS_PROCESSOR)
  })
})

describe('staticDataExtensions (pre-React bootstrap runtime)', () => {
  // Second registration site: `staticDataExtensions` is what the Repo is
  // constructed with, before any React runtime resolves, so the ordering
  // invariant has to hold here independently of the app runtime.
  it('orders alias.sync before references.renameBacklinks', () => {
    const order = [
      ...resolveFacetRuntimeSync(staticDataExtensions).read(sameTxProcessorsFacet).keys(),
    ]
    expect(order).toContain(ALIAS_SYNC_PROCESSOR)
    expect(order.indexOf(ALIAS_SYNC_PROCESSOR))
      .toBeLessThan(order.indexOf(RENAME_BACKLINKS_PROCESSOR))
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
