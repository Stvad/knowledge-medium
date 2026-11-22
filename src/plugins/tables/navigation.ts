/** Up and Down in normal mode, into, through and out of a table. The outline's
 *  walk reads the host's children from the outline model: the view and column
 *  blocks, then the rows in the host's own scope. The table draws none of
 *  that: it draws the query's field rows in the host's scope, then the rows
 *  in its own. So where a step enters, leaves or stays inside what the table
 *  draws, the order on screen is the order, and the step takes the drawn
 *  neighbour. Steps between rows are the grid's (`GridController.command`),
 *  which declines at its first and last row. */
import { focusBlock, type FocusedBlockLocation } from '@/data/properties'
import { resolveSpatialNavExclusions } from '@/plugins/spatial-navigation/exclusionsFacet'
import { instanceAt, locationOf, panelOf, reservedRowBetween, verticalNeighbor } from '@/plugins/spatial-navigation/walker'
import type { ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import { ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types'

/** On a table host's shell. */
export const TABLE_HOST_ATTRIBUTE = 'data-table-host'
/** On what a table draws where its host's children would be. */
export const TABLE_CHILDREN_ATTRIBUTE = 'data-table-children'

const isHost = (element: HTMLElement | null) => element?.hasAttribute(TABLE_HOST_ATTRIBUTE) === true
const isInTable = (element: HTMLElement | null) => element?.closest(`[${TABLE_CHILDREN_ATTRIBUTE}]`) != null

type Direction = 'up' | 'down'

/** Where Up or Down from the focused block lands, when the step touches a
 *  table: `undefined` when it does not (the outline's walk is right there),
 *  `null` when it does and nothing is drawn to move to. A step from a host
 *  down, or up onto one, crosses the host's children, so it is a table step
 *  even when the table draws no rows. A neighbour in another panel is left to
 *  spatial navigation, which owns the step across panels. */
const tableStep = (deps: BlockShortcutDependencies, direction: Direction): FocusedBlockLocation | null | undefined => {
  const {block, uiStateBlock, renderScopeId} = deps
  if (!block || !uiStateBlock || !renderScopeId) return undefined
  const excluded = resolveSpatialNavExclusions(block.repo.facetRuntime)
  const current = instanceAt(uiStateBlock.id, {blockId: block.id, renderScopeId}, excluded)
  if (!current) return undefined
  const neighbour = verticalNeighbor(current, direction, excluded)
  const [upper, lower] = direction === 'down' ? [current, neighbour] : [neighbour, current]
  if (!isHost(upper) && !isInTable(upper) && !isInTable(lower)) return undefined
  if (neighbour && panelOf(neighbour) !== panelOf(current)) return undefined
  // A row not mounted yet holds its place with a slot: land there, not past it.
  return reservedRowBetween(current, neighbour, direction, excluded) ?? (neighbour ? locationOf(neighbour) : null)
}

const tableVertical = (actionId: 'move_down' | 'move_up', direction: Direction): ActionDispatchDecorator => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  wrap: async (deps, trigger, next) => {
    const target = tableStep(deps as BlockShortcutDependencies, direction)
    if (target === undefined) {
      await next(deps, trigger)
      return
    }
    if (target) void focusBlock(deps.uiStateBlock, target.blockId, {renderScopeId: target.renderScopeId})
  },
})

/** Inside the grid's own redirect (which steps between rows), outside the
 *  spatial walk (whose model is wrong around a table). */
export const TABLE_VERTICAL_PRECEDENCE = 50

export const tableVerticalSteps: ActionDispatchDecorator[] = [
  tableVertical('move_down', 'down'),
  tableVertical('move_up', 'up'),
]
