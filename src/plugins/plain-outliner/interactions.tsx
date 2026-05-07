import type { MouseEvent } from 'react'
import {
  BlockClickContribution,
  BlockContentRendererContribution,
  enterBlockEditMode,
  getBlockContentRendererSlot,
  handleBlockSelectionClick,
  isInteractiveContentEvent,
  isSelectionClick,
} from '@/extensions/blockInteraction.ts'
import { useInEditMode } from '@/data/globalState.ts'
import type { BlockRenderer } from '@/types.ts'

// Dispatch between primary (display) and secondary (editor) renderer at
// render time rather than resolve time. Reading `inEditMode` here keeps
// the resolved content-renderer identity stable per (block, registry),
// which in turn keeps the surrounding decorator chain — UpdateIndicator
// and friends — mounted across edit-mode toggles.
//
// Registered as a variant on `blockContentRendererFacet`. The
// DefaultBlockRenderer picks `last`, so this single variant wins
// whenever it's contributed (same semantics as the legacy last-wins
// facet — see commit migrating to defineVariantFacet).
export const blockEditingContentRenderer: BlockContentRendererContribution = context => {
  const Primary = getBlockContentRendererSlot(context, 'primary')
  if (!Primary) return null
  const Secondary = getBlockContentRendererSlot(context, 'secondary') ?? Primary

  const renderer: BlockRenderer = Primary === Secondary
    ? Primary
    : (() => {
      const Dispatcher: BlockRenderer = (props) => {
        const inEditMode = useInEditMode(props.block.id)
        const Renderer = inEditMode ? Secondary : Primary
        return <Renderer {...props}/>
      }
      Dispatcher.displayName = 'BlockEditingDispatcher'
      return Dispatcher
    })()

  return {
    id: 'plain-outliner.editing-dispatcher',
    label: 'Editing dispatcher',
    render: renderer,
  }
}

export const plainOutlinerBlockClickBehavior: BlockClickContribution = context =>
  async (event: MouseEvent) => {
    if (isInteractiveContentEvent(event)) return

    if (isSelectionClick(event)) {
      await handleBlockSelectionClick(context, event)
      return
    }

    event.preventDefault()
    event.stopPropagation()

    await enterBlockEditMode(context, {
      x: event.clientX,
      y: event.clientY,
    })
  }
