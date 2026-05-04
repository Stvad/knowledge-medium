import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent } from 'react'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { BlockRenderer } from '@/types.ts'
import {
  blockContentRendererFacet,
  BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  blockEditingContentRenderer,
  plainOutlinerBlockClickBehavior,
} from '../interactions.tsx'

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
  it('returns a dispatcher that resolves to neither raw slot directly', () => {
    // Resolution-time output is now stable per (block, registry) — a
    // dispatcher component that picks Primary vs Secondary at render
    // time. The specific runtime selection is exercised end-to-end by
    // the renderer; here we just assert the dispatch indirection so the
    // resolver no longer toggles its return identity on inEditMode.
    const runtime = resolveFacetRuntimeSync([
      blockContentRendererFacet.of(blockEditingContentRenderer),
    ])

    const resolveRenderer = runtime.read(blockContentRendererFacet)
    const renderer = resolveRenderer(context)

    expect(renderer).toBeDefined()
    expect(renderer).not.toBe(PrimaryRenderer)
    expect(renderer).not.toBe(SecondaryRenderer)
    expect((renderer as { displayName?: string }).displayName).toBe('BlockEditingDispatcher')
  })

  it('falls through to the primary slot when no secondary is registered', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentRendererFacet.of(blockEditingContentRenderer),
    ])

    const resolveRenderer = runtime.read(blockContentRendererFacet)
    const renderer = resolveRenderer({
      ...context,
      contentRenderers: [{id: 'primary', renderer: PrimaryRenderer}],
    })

    expect(renderer).toBe(PrimaryRenderer)
  })

  it('leaves anchor clicks to browser navigation', async () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const child = document.createElement('span')
    link.appendChild(child)

    const event = {
      target: child,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      clientX: 1,
      clientY: 1,
    } as unknown as MouseEvent

    const handler = plainOutlinerBlockClickBehavior(context)
    if (!handler) throw new Error('Expected plain outliner click handler')

    await handler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })
})
