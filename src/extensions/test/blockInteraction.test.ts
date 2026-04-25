import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
import {
  blockClickHandlersFacet,
  BlockClickContribution,
  BlockInteractionContext,
  ShortcutActivationContribution,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { codeMirrorEditModeActivation } from '@/extensions/defaultEditorInteractions.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

describe('block interaction facets', () => {
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

  it('defines CodeMirror edit mode through editor surface activations', () => {
    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation),
    ])

    const resolveActivations = runtime.read(shortcutSurfaceActivationsFacet)
    const editorView = {} as never

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
