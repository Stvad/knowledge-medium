import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import type { BlockRenderer } from '@/types.ts'
import {
  blockContentRendererFacet,
  BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { blockEditingContentRenderer } from '../interactions.ts'

const PrimaryRenderer: BlockRenderer = () => null
const SecondaryRenderer: BlockRenderer = () => null

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [
    {
      id: 'primary',
      renderer: PrimaryRenderer,
    },
    {
      id: 'secondary',
      renderer: SecondaryRenderer,
    },
  ],
} satisfies BlockInteractionContext

describe('plain outliner interactions', () => {
  it('chooses block content renderers through a renderer facet', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentRendererFacet.of(blockEditingContentRenderer),
    ])

    const resolveRenderer = runtime.read(blockContentRendererFacet)

    expect(resolveRenderer(context)).toBe(PrimaryRenderer)
    expect(resolveRenderer({
      ...context,
      inEditMode: true,
    })).toBe(SecondaryRenderer)
  })
})
