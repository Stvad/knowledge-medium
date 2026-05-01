import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import {
  blockContentSurfacePropsFacet,
  BlockInteractionContext,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import {
  vimContentSurfaceBehavior,
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
  it('contributes content-surface props for double-click and tap detection', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
    ])

    const props = runtime.read(blockContentSurfacePropsFacet)(context)

    expect(props.onMouseDownCapture).toBeDefined()
    expect(props.onTouchStart).toBeDefined()
    expect(props.onTouchEnd).toBeDefined()
  })

  it('contributes nothing in edit mode', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
    ])

    const props = runtime.read(blockContentSurfacePropsFacet)({...context, inEditMode: true})

    expect(props).toEqual({})
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
