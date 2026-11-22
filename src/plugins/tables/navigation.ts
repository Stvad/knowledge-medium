/** Up and Down in normal mode, into, through and out of a table. The outline's
 *  model of a host's children is not what the table draws: the model has the
 *  view and column blocks, then the rows in the host's own scope, interleaved
 *  with the children outside the query; the table draws the query's field
 *  rows, then the rows in a scope of its own, then the children outside the
 *  query. A step that enters, leaves or stays inside what the table draws
 *  never consults that model: it takes the drawn neighbour. Steps between rows
 *  are the grid's (`GridController.command`), which takes this step at its
 *  first and last row. */
import { focusBlock, type FocusedBlockLocation } from '@/data/properties'
import { crossPanelFocus } from '@/plugins/spatial-navigation/actions'
import { resolveSpatialNavExclusions } from '@/plugins/spatial-navigation/exclusionsFacet'
import { instanceAt, locationOf, panelById, panelOf, reservedRowBetween, verticalNeighbor } from '@/plugins/spatial-navigation/walker'
import { actionDispatchWrap, type ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import { ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types'

/** On a table host's shell. */
export const TABLE_HOST_ATTRIBUTE = 'data-table-host'
/** On what a table draws in place of its host's children. */
export const TABLE_CHILDREN_ATTRIBUTE = 'data-table-children'

const isHost = (element: HTMLElement | null) => element?.hasAttribute(TABLE_HOST_ATTRIBUTE) === true
const isInTable = (element: HTMLElement | null) => element?.closest(`[${TABLE_CHILDREN_ATTRIBUTE}]`) != null

type Direction = 'up' | 'down'
type StepFrom = Pick<BlockShortcutDependencies, 'block' | 'uiStateBlock' | 'renderScopeId'>

interface Target {
  panelId: string
  location: FocusedBlockLocation
}

/** Where Up or Down from the focused block lands, when the step touches a
 *  table: `undefined` when it does not (the outline's walk is right there),
 *  `null` when it does and nothing is drawn to move to. A step from a host
 *  down, or up onto one, crosses the host's children, so it is a table step
 *  even when the table draws no rows or is collapsed. */
const tableStep = ({block, uiStateBlock, renderScopeId}: StepFrom, direction: Direction): Target | null | undefined => {
  if (!block || !uiStateBlock || !renderScopeId) return undefined
  // Every key in every panel passes here: a panel with no table costs one query.
  if (!panelById(uiStateBlock.id)?.querySelector(`[${TABLE_HOST_ATTRIBUTE}]`)) return undefined
  const excluded = resolveSpatialNavExclusions(block.repo.facetRuntime)
  const current = instanceAt(uiStateBlock.id, {blockId: block.id, renderScopeId}, excluded)
  if (!current) return undefined
  const neighbour = verticalNeighbor(current, direction, excluded)
  const [upper, lower] = direction === 'down' ? [current, neighbour] : [neighbour, current]
  if (!isHost(upper) && !isInTable(upper) && !isInTable(lower)) return undefined
  // A row not mounted yet holds its place with a slot: land there, not past it.
  const reserved = reservedRowBetween(current, neighbour, direction, excluded, 'include')
  if (reserved) return {panelId: uiStateBlock.id, location: reserved}
  const location = neighbour && locationOf(neighbour)
  const panelId = neighbour && panelOf(neighbour)?.dataset.panelId
  return location && panelId ? {panelId, location} : null
}

/** Takes the step when it is a table's; false when the outline's walk should. */
export const takeTableStep = (from: StepFrom, direction: Direction): boolean => {
  const target = tableStep(from, direction)
  if (target === undefined) return false
  if (!target) return true
  if (target.panelId === from.uiStateBlock.id) {
    void focusBlock(from.uiStateBlock, target.location.blockId, {renderScopeId: target.location.renderScopeId})
  } else {
    void crossPanelFocus(from.uiStateBlock, target.panelId, target.location)
  }
  return true
}

const tableVertical = (actionId: 'move_down' | 'move_up', direction: Direction): ActionDispatchDecorator => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  wrap: async (deps, trigger, next, dispatch) => {
    if (!takeTableStep(deps as BlockShortcutDependencies, direction)) await next(deps, trigger, dispatch)
  },
})

/** Inside the grid's own redirects (precedence 100, `./keys`), which step
 *  between rows; outside spatial navigation's walk, whose model is wrong
 *  around a table. */
export const tableVerticalSteps = [
  tableVertical('move_down', 'down'),
  tableVertical('move_up', 'up'),
].map(decorator => actionDispatchWrap(decorator, {source: 'tables', precedence: 50}))
