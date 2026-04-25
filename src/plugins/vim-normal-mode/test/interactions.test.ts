import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
import {
  blockContentGestureHandlersFacet,
  BlockInteractionContext,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import {
  vimContentGestureBehavior,
  vimNormalModeActivation,
} from '../interactions.ts'

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

describe('vim normal mode interactions', () => {
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
})
