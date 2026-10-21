import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { blockRendererFacet, type BlockRendererContext } from '@/extensions/blockInteraction.js'
import { coreRendererLadder, defaultRenderersExtension } from '@/extensions/defaultRenderers.js'
import { PropertySchemaBlockRenderer } from '@/components/renderer/PropertySchemaBlockRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'

const loadedBlock = {peek: () => ({id: 'b'})} as unknown as Block

const claimant = (types: string[]) => {
  const ctx: BlockRendererContext = {block: loadedBlock, repo: {} as Repo, types}
  return resolveFacetRuntimeSync(defaultRenderersExtension).read(blockRendererFacet)(ctx).last
}

/** The same ladder registered back-to-front. Precedence is supposed to be the
 *  whole ranking, so every outcome must survive this; anything that doesn't
 *  was really being decided by the order of the array. */
const claimantFromReversedLadder = (types: string[]) => {
  const ctx: BlockRendererContext = {block: loadedBlock, repo: {} as Repo, types}
  const runtime = resolveFacetRuntimeSync(
    coreRendererLadder.toReversed().map(([registration, precedence]) =>
      blockRendererFacet.of(registration, {precedence, source: 'test'})),
  )
  return runtime.read(blockRendererFacet)(ctx).last
}

describe('core renderer ladder', () => {
  it('leaves an untyped block to the plain renderer', () => {
    expect(claimant([])?.render).toBe(DefaultBlockRenderer)
  })

  // Types are a list and a block may legally carry both. The two editors
  // therefore cannot share a precedence — an equal one is broken by
  // registration order, which is not something either file states.
  it('gives a block carrying BOTH editor types to the schema editor', () => {
    expect(claimant(['property-schema'])?.render).toBe(PropertySchemaBlockRenderer)
    expect(claimant(['property-schema', 'block-type'])?.render).toBe(PropertySchemaBlockRenderer)
    expect(claimant(['block-type', 'property-schema'])?.render).toBe(PropertySchemaBlockRenderer)
    expect(claimantFromReversedLadder(['property-schema', 'block-type'])?.render)
      .toBe(PropertySchemaBlockRenderer)
  })
})
