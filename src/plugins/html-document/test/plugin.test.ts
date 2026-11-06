// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {EXTENSION_TYPE} from '@/data/blockTypes'
import {typeSeedsFacet} from '@/data/facets'
import {blockContentRendererFacet, blockLayoutFacet, type BlockResolveContext} from '@/extensions/blockInteraction.js'
import {staticDataExtensions} from '@/extensions/staticDataExtensions.js'
import {resolveFacetRuntimeSync} from '@/facets/facet.js'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {HTML_DOCUMENT_TYPE, htmlDocumentPlugin} from '../index.ts'

const contextFor = (types: readonly string[], blockContext: BlockResolveContext['blockContext'] = {}) =>
  ({types, blockContext, contentRenderers: [{id: 'primary', renderer: () => null}]}) as unknown as BlockResolveContext

describe('htmlDocumentPlugin', () => {
  // Composed in the order the app composes them: plain-outliner's dispatcher
  // contributes for every block, and last wins.
  const runtime = resolveFacetRuntimeSync([plainOutlinerPlugin, referencesPlugin, htmlDocumentPlugin])
  const runtimeBefore = resolveFacetRuntimeSync([htmlDocumentPlugin, plainOutlinerPlugin, referencesPlugin])

  it.each([['after', runtime], ['before', runtimeBefore]])('wins the content slot for a typed block when composed %s the outliner', (_order, r) => {
    expect(r.read(blockContentRendererFacet)(contextFor([HTML_DOCUMENT_TYPE])).last?.id).toBe('html-document.frame')
  })

  it('never replaces the source viewer of a block that is also an extension', () => {
    expect(runtime.read(blockContentRendererFacet)(contextFor([EXTENSION_TYPE, HTML_DOCUMENT_TYPE])).last?.id)
      .toBe('plain-outliner.editing-dispatcher')
  })

  it('leaves every other block to the outliner', () => {
    expect(runtime.read(blockContentRendererFacet)(contextFor(['todo'])).last?.id).toBe('plain-outliner.editing-dispatcher')
  })

  it.each([['after', runtime], ['before', runtimeBefore]])('wins the layout of a typed block cited as a reference when composed %s', (_order, r) => {
    expect(r.read(blockLayoutFacet)(contextFor([HTML_DOCUMENT_TYPE], {isReference: true})).last?.id).toBe('html-document.reference')
  })

  it('leaves the layout of an embed, and of a plain citation, alone', () => {
    expect(runtime.read(blockLayoutFacet)(contextFor([HTML_DOCUMENT_TYPE], {isReference: false})).last?.id).not.toBe('html-document.reference')
    expect(runtime.read(blockLayoutFacet)(contextFor(['todo'], {isReference: true})).last?.id).toBe('references.reference')
  })

  it('declares the type where repo bootstrap can see it', () => {
    const seeds = resolveFacetRuntimeSync(staticDataExtensions).read(typeSeedsFacet)
    expect(JSON.stringify(seeds)).toContain(HTML_DOCUMENT_TYPE)
  })
})
