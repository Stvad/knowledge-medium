// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import {
  invalidationRulesFacet,
  localSchemaFacet,
} from '@/data/facets.js'
import { referencesDataExtension } from '../dataExtension.ts'
import { referencesPlugin } from '../index.ts'
import { referencesInvalidationRule } from '../invalidation.ts'
import { referencesLocalSchema } from '../localSchema.ts'

describe('referencesDataExtension', () => {
  it('contributes the local reference edge index schema', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(localSchemaFacet)).toEqual([referencesLocalSchema])
  })

  it('contributes reference invalidation', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(invalidationRulesFacet)).toEqual([referencesInvalidationRule])
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
