/** Property rows in the outline (issue #1674): on a child-backed workspace a
 *  block's property field rows render in place as name/value rows, filtered by
 *  the property display mode (`@/data/propertyDisplayMode`), with commands and
 *  a bullet-menu entry for its workspace and block levels. */
import type { BlockContextMenuItemsContribution } from '@/extensions/blockInteraction.js'
import { blockContextMenuItemsFacet } from '@/extensions/blockInteraction.js'
import { actionsFacet, blockRenderersFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { blockSetting, cyclePropertyDisplayActions, propertyDisplayActions, setBlockPropertyDisplay } from './actions'
import { FieldRowRenderer } from './FieldRowRenderer'
import { ValueRowRenderer } from './ValueRowRenderer'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount'
import { addFieldAction } from './addField'

const SOURCE = 'property-rows'

/** The doc's per-block reveal: show every property row on this block, or hand
 *  it back to the default. Decided at click time, so the static label never
 *  goes stale. On every block, cell-backed workspaces included: a contribution
 *  is resolved from BlockContext, which must not carry the workspace's
 *  child-backed state (a flip there would remount every block's content);
 *  there the setting is stored and shows nothing. */
const revealPropertiesMenuItem: BlockContextMenuItemsContribution = ({block}) => ({
  id: 'property-rows.toggle-reveal',
  label: 'Toggle all properties here',
  onSelect: () => {
    void setBlockPropertyDisplay([block], blockSetting(block) === 'all' ? 'inherit' : 'all')
  },
})

export const propertyRowsPlugin: AppExtension = systemToggle({
  id: 'system:property-rows',
  name: 'Property rows',
  description: 'On a workspace whose properties are blocks, show a block\'s properties in the outline as name/value rows, with workspace and per-block display modes.',
}).of([
  dialogAppMountExtension,
  actionsFacet.of(addFieldAction, {source: SOURCE}),
  blockRenderersFacet.of({id: 'propertyFieldRow', renderer: FieldRowRenderer}, {source: SOURCE}),
  blockRenderersFacet.of({id: 'propertyValueRow', renderer: ValueRowRenderer}, {source: SOURCE}),
  blockContextMenuItemsFacet.of(revealPropertiesMenuItem, {source: SOURCE}),
  propertyDisplayActions.map(action => actionsFacet.of(action, {source: SOURCE})),
  cyclePropertyDisplayActions.map(action => actionsFacet.of(action, {source: SOURCE, precedence: -100})),
])
