// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { BlockRenderer } from '@/types.js'
import {
  blockContentRendererFacet,
  BlockInteractionContext,
} from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import type { ActionTrigger, BlockPointerDependencies } from '@/shortcuts/types.js'
import { blockEditingContentRenderer } from '../interactions.tsx'
import { enterBlockEditModeOnClickAction } from '../clickToEditAction.ts'

const enterEditModeForBlock = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/blockInteraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/blockInteraction.js')>()),
  enterEditModeForBlock,
}))

const grabSoftKeyboard = vi.hoisted(() => vi.fn())
vi.mock('@/utils/softKeyboardGrab.js', () => ({ grabSoftKeyboard }))

const PrimaryRenderer: BlockRenderer = () => null
const SecondaryRenderer: BlockRenderer = () => null

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  types: [],
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
  it('returns a dispatcher variant that resolves to neither raw slot directly', () => {
    // Resolution-time output is now stable per (block, registry) — a
    // dispatcher component that picks Primary vs Secondary at render
    // time. The specific runtime selection is exercised end-to-end by
    // the renderer; here we just assert the dispatch indirection so the
    // resolver no longer toggles its return identity on inEditMode.
    const runtime = resolveFacetRuntimeSync([
      blockContentRendererFacet.of(blockEditingContentRenderer),
    ])

    const variant = runtime.read(blockContentRendererFacet)(context).last
    expect(variant).toBeDefined()
    expect(variant?.id).toBe('plain-outliner.editing-dispatcher')
    const renderer = variant?.render
    expect(renderer).not.toBe(PrimaryRenderer)
    expect(renderer).not.toBe(SecondaryRenderer)
    expect((renderer as { displayName?: string } | undefined)?.displayName).toBe('BlockEditingDispatcher')
  })

  it('falls through to the primary slot when no secondary is registered', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentRendererFacet.of(blockEditingContentRenderer),
    ])

    const variant = runtime.read(blockContentRendererFacet)({
      ...context,
      contentRenderers: [{id: 'primary', renderer: PrimaryRenderer}],
    }).last

    expect(variant?.render).toBe(PrimaryRenderer)
  })

})

describe('plain outliner click-to-edit action', () => {
  const deps = (isReadOnly = false): BlockPointerDependencies => ({
    block: {id: 'block-1'} as Block,
    uiStateBlock: {id: 'panel', repo: {isReadOnly}} as unknown as Block,
    targetElement: document.createElement('div'),
    renderVisibilityPolicy: {},
    renderScopeId: 'scope-a',
  })

  const clickEvent = (target: EventTarget): ActionTrigger => ({
    target,
    clientX: 4,
    clientY: 8,
  }) as unknown as ActionTrigger

  it('enters edit mode at the click position and grabs the keyboard on a plain click', () => {
    // Interactive-target exclusion is the block-pointer context's job
    // (pointerTargetFilter), so this action assumes a real surface click and
    // just enters edit mode at the click position.
    enterEditModeForBlock.mockClear()
    grabSoftKeyboard.mockClear()
    const target = document.createElement('span')
    const d = deps()

    enterBlockEditModeOnClickAction.handler(d, clickEvent(target))

    expect(enterEditModeForBlock).toHaveBeenCalledWith(
      d.block, d.uiStateBlock, 'scope-a', {x: 4, y: 8},
    )
    expect(grabSoftKeyboard).toHaveBeenCalledOnce()
  })

  it('does not grab the keyboard in a read-only workspace (no editor will mount)', () => {
    // Read-only no-ops edit mode, so grabbing would raise a soft keyboard with
    // nothing to type into until the failsafe blurs it.
    enterEditModeForBlock.mockClear()
    grabSoftKeyboard.mockClear()
    const d = deps(true)

    enterBlockEditModeOnClickAction.handler(d, clickEvent(document.createElement('span')))

    expect(grabSoftKeyboard).not.toHaveBeenCalled()
  })
})
