import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
import type { BlockRenderer } from '@/types.ts'
import {
  blockClickHandlersFacet,
  BlockClickContribution,
  blockContentGestureHandlersFacet,
  blockContentRendererFacet,
  BlockInteractionContext,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  blockEditingContentRenderer,
  codeMirrorEditModeActivation,
  textareaEditModeActivation,
  vimContentGestureBehavior,
  vimNormalModeActivation,
} from '@/shortcuts/blockInteractionPolicies.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

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

describe('block interaction facets', () => {
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

  it('lets a higher precedence click contribution replace baseline block clicks', () => {
    const baselineHandler = () => undefined
    const replacementHandler = () => undefined
    const baselineContribution: BlockClickContribution = () => baselineHandler
    const replacementContribution: BlockClickContribution = () => replacementHandler
    const runtime = resolveFacetRuntimeSync([
      blockClickHandlersFacet.of(baselineContribution),
      blockClickHandlersFacet.of(replacementContribution, {precedence: 100}),
    ])

    const handler = runtime.read(blockClickHandlersFacet)(context)

    expect(handler).toBe(replacementHandler)
  })

  it('supplies content gestures separately from block click behavior', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentGestureHandlersFacet.of(vimContentGestureBehavior),
    ])

    const handlers = runtime.read(blockContentGestureHandlersFacet)(context)

    expect(handlers.onDoubleClick).toBeDefined()
    expect(handlers.onTap).toBeDefined()
  })

  it('defines Vim normal mode as a shortcut surface activation', () => {
    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(vimNormalModeActivation),
    ])

    const resolveActivations = runtime.read(shortcutSurfaceActivationsFacet)

    expect(resolveActivations({
      ...context,
      surface: 'block',
    })).toEqual([{
      context: ActionContextTypes.NORMAL_MODE,
      dependencies: {
        block: context.block,
      },
    }])
    expect(resolveActivations({
      ...context,
      inEditMode: true,
      surface: 'block',
    })).toEqual([])
  })

  it('defines edit mode contexts through editor surface activations', () => {
    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(textareaEditModeActivation),
      shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation),
    ])

    const resolveActivations = runtime.read(shortcutSurfaceActivationsFacet)
    const textarea = {} as HTMLTextAreaElement
    const editorView = {} as never

    expect(resolveActivations({
      ...context,
      surface: 'textarea',
      textarea,
    })).toEqual([{
      context: ActionContextTypes.EDIT_MODE,
      dependencies: {
        block: context.block,
        textarea,
      },
    }])
    expect(resolveActivations({
      ...context,
      surface: 'codemirror',
      editorView,
    })).toEqual([{
      context: ActionContextTypes.EDIT_MODE_CM,
      dependencies: {
        block: context.block,
        editorView,
      },
    }])
  })

  it('allows a contribution to introduce an application-specific mode', () => {
    const customModeActivation: ShortcutActivationContribution = activationContext =>
      activationContext.surface === 'block'
        ? [{
          context: 'custom-mode',
          dependencies: {
            block: activationContext.block,
          },
        }]
        : null

    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(customModeActivation),
    ])

    expect(runtime.read(shortcutSurfaceActivationsFacet)({
      ...context,
      surface: 'block',
    })).toEqual([{
      context: 'custom-mode',
      dependencies: {
        block: context.block,
      },
    }])
  })
})
