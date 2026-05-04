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
export const blockEditingContentRenderer: BlockContentRendererContribution = context => {
  const Primary = getBlockContentRendererSlot(context, 'primary')
  if (!Primary) return undefined
  const Secondary = getBlockContentRendererSlot(context, 'secondary') ?? Primary

  if (Primary === Secondary) return Primary

  const Dispatcher: BlockRenderer = (props) => {
    const inEditMode = useInEditMode(props.block.id)
    const Renderer = inEditMode ? Secondary : Primary
    return <Renderer {...props}/>
  }
  Dispatcher.displayName = 'BlockEditingDispatcher'
  return Dispatcher
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
