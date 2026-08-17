import {
  BlockContentRendererContribution,
  getBlockContentRendererSlot,
} from '@/extensions/blockInteraction.js'
import { useInEditMode } from '@/data/globalState.js'
import type { BlockRenderer } from '@/types.js'

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
      // Hand-off: the dispatcher shows one of its two slots, both of which are
      // the block's text in the ordinary case. Without this every block in the
      // app reads as a view, since this wrapper is what the slot actually sees.
      Dispatcher.showsOwnContent = Primary.showsOwnContent
      return Dispatcher
    })()

  return {
    id: 'plain-outliner.editing-dispatcher',
    label: 'Editing dispatcher',
    render: renderer,
  }
}
