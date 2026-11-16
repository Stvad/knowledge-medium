import {drawsPropertyRows} from './fieldRow'
import {actionDispatchWrap} from '@/shortcuts/actionDispatch'
import {ActionContextTypes, type BlockShortcutDependencies} from '@/shortcuts/types'
import {navigatePlaceholder} from '@/utils/outlinePlaceholderNavigation'
import {placeholderMoves} from './placeholderKeys'
import {blockChildrenFooterFacet} from '@/extensions/blockInteraction'
import {codeMirrorExtensionsFacet} from '@/editor/codeMirrorExtensions'
import {propertyAutocomplete} from './autocomplete'
import {ExpectedPropertyRows} from './ExpectedPropertyRows'
/** Property rows in the outline (issue #1674): on a child-backed workspace a
 *  block's property field rows render in place as name/value rows, filtered by
 *  the property display mode (`@/data/propertyDisplayMode`), with commands and
 *  a bullet-menu entry for its workspace and block levels. */
import type { BlockContextMenuItemsContribution } from '@/extensions/blockInteraction.js'
import { blockContextMenuItemsFacet, blockLayoutFacet, blockReadContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { blockSetting, cyclePropertyDisplayActions, propertyDisplayActions, setBlockPropertyDisplay } from './actions'
import { fieldRowLayoutContribution } from './FieldRowRenderer'
import { propertyReadContentContribution } from './ValueRowRenderer'

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
  Object.entries(placeholderMoves).map(([actionId, direction]) => actionDispatchWrap({actionId, context: ActionContextTypes.NORMAL_MODE,
    wrap: async (deps, trigger, next) => {
      const {block, renderScopeId, uiStateBlock} = deps as BlockShortcutDependencies
      if (!await navigatePlaceholder(block.id, renderScopeId, direction, uiStateBlock, false)) await next(deps, trigger)
    },
  }, {source: SOURCE})),
  codeMirrorExtensionsFacet.of(propertyAutocomplete, {source: SOURCE}),
  blockChildrenFooterFacet.of(context => drawsPropertyRows(context.blockContext) ? ExpectedPropertyRows : null, {source: SOURCE, precedence: -100}),
  blockLayoutFacet.of(fieldRowLayoutContribution, {source: SOURCE, precedence: -100}),
  blockReadContentDecoratorsFacet.of(propertyReadContentContribution, {source: SOURCE}),
  blockContextMenuItemsFacet.of(revealPropertiesMenuItem, {source: SOURCE}),
  propertyDisplayActions.map(action => actionsFacet.of(action, {source: SOURCE})),
  cyclePropertyDisplayActions.map(action => actionsFacet.of(action, {source: SOURCE, precedence: -100})),
])
