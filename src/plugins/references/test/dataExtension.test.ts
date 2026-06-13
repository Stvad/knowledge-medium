// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
  sameTxProcessorsFacet,
} from '@/data/facets.js'
import { referencesDataExtension } from '../dataExtension.ts'
import { referencesPlugin } from '../index.ts'
import { referencesInvalidationRule } from '../invalidation.ts'
import { referencesLocalSchema } from '../localSchema.ts'
import {
  CLEANUP_ORPHAN_ALIASES_PROCESSOR,
  PARSE_REFERENCES_PROCESSOR,
} from '../referencesProcessor.ts'
import { RENAME_BACKLINKS_PROCESSOR } from '../renameProcessor.ts'
import { RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR } from '../mergeRetargetProcessor.ts'

describe('referencesDataExtension', () => {
  it('contributes the local reference edge index schema', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(localSchemaFacet)).toEqual([referencesLocalSchema])
  })

  it('contributes reference invalidation', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(runtime.read(invalidationRulesFacet)).toEqual([referencesInvalidationRule])
  })

  it('contributes reference post-commit processors', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(Array.from(runtime.read(postCommitProcessorsFacet).keys()).sort()).toEqual([
      CLEANUP_ORPHAN_ALIASES_PROCESSOR,
      PARSE_REFERENCES_PROCESSOR,
      RENAME_BACKLINKS_PROCESSOR,
    ].sort())
  })

  it('contributes reference same-tx processors', () => {
    const runtime = resolveFacetRuntimeSync(referencesDataExtension)
    expect(Array.from(runtime.read(sameTxProcessorsFacet).keys())).toEqual([
      RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR,
    ])
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
