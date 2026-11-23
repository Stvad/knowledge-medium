/** The outline's structural verbs on a table's rows. Each row is the root of
 *  its own scope, so inside a row (its children) the outline's verbs run as
 *  they are, and at a row the outline refuses them. Between rows the grid
 *  decides, by the rows it draws: their order may be a sort's, and a query's
 *  rows live anywhere. Where the host's own order is the drawn one, the
 *  outline's handler runs with the host as the scope root. */
import type { Block } from '@/data/block'
import { listingSurfaceOf } from '@/data/childrenView'
import { focusBlock } from '@/data/properties'
import { actionDispatchWrap, type ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import { requestEditorFocusIfEditing } from '@/shortcuts/blockActions'
import { mergeUp } from '@/shortcuts/blockMergeGesture'
import {
  ActionContextTypes, type ActionContextType, type BaseShortcutDependencies, type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { deleteBlockThroughUi } from '@/utils/deleteBlockThroughUi'
import { showInfo } from '@/utils/toast'
import type { GridController } from './controller'
import { gridDrawing } from './registry'

const NORMAL = ActionContextTypes.NORMAL_MODE
const EDITING = ActionContextTypes.EDIT_MODE_CM

/** The grid drawing `deps.block` as one of its rows, if it is one. */
const rowGrid = (deps: BaseShortcutDependencies): GridController | undefined => {
  const {block, renderScopeId} = deps as BlockShortcutDependencies
  const grid = gridDrawing(renderScopeId, block?.id)
  return block && grid?.isRow(block.id) ? grid : undefined
}

/** A verb the grid takes on a row; anywhere else the outline's runs. */
const onRow = (
  context: ActionContextType, actionId: string,
  take: (grid: GridController, deps: BlockShortcutDependencies) => Promise<void> | void,
): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: async (deps, trigger, next) => {
    const grid = rowGrid(deps)
    if (!grid) {
      await next(deps, trigger)
      return
    }
    await take(grid, deps as BlockShortcutDependencies)
    requestEditorFocusIfEditing((deps as BlockShortcutDependencies).uiStateBlock)
  },
})

/** Enter in a row's text, by the outline's own split with the host as the
 *  scope root: at the end a new row below, or a first child when the row's
 *  children show; mid-text the row splits in two. A query's rows live
 *  anywhere: there the end makes a first child as the outline does when the
 *  children show, else a new row as "+ New row" does, and a split is refused. */
const splitRow: ActionDispatchDecorator = {
  actionId: 'split_block_cm',
  context: EDITING,
  wrap: async (deps, trigger, next) => {
    const grid = rowGrid(deps)
    const {block, editorView} = deps as CodeMirrorEditModeDependencies
    if (!grid || !editorView) {
      await next(deps, trigger)
      return
    }
    const atEnd = editorView.state.selection.main.head === editorView.state.doc.length
    const makesChild = atEnd && (await grid.drawnChildIds(block.id)).length > 0
    if (!grid.hasQuery) {
      // Only a new row counts against the row cap; a first child does not.
      if (makesChild || grid.allowsNewRow()) await next({...deps, scopeRootId: grid.host.id}, trigger)
      return
    }
    if (!atEnd) {
      showInfo('A query table’s row splits in the outline.')
    } else if (makesChild) {
      await next(deps, trigger)
    } else {
      grid.command('insert-below')
    }
  },
}

/** Shift+Tab on a row's own child: the outline's outdent with the host as the
 *  scope root, which places it right after the row, as a row. */
const unnestChild = (context: ActionContextType, actionId: string): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: async (deps, trigger, next) => {
    const {block, renderScopeId, scopeRootId} = deps as BlockShortcutDependencies
    const grid = gridDrawing(renderScopeId, block?.id)
    const parentId = block?.peek()?.parentId
    if (!grid || !parentId || parentId !== scopeRootId || !grid.isRow(parentId)) {
      await next(deps, trigger)
      return
    }
    if (grid.refusesUnderQuery() || !grid.allowsNewRow()) return
    await next({...deps, scopeRootId: grid.host.id}, trigger)
  },
})

/** Whether `row` carries property values a merge would fold into another
 *  block: any property but hidden, internal ones (its collapse flag). */
const carriesValues = (row: Block): boolean => {
  const data = row.peek()
  if (!data) return false
  const definitions = row.repo.propertySchemaResolverFor(data.workspaceId)
  return Object.keys(data.properties).some(name => {
    const definition = definitions.resolve(name)
    return definition.status !== 'resolved' || !definition.schema.hidden
  })
}

/** Backspace at the start of a row's text: the row merges into the last block
 *  drawn above it (`GridController.lastDrawnIn`), by the outline's own merge
 *  and its refusals. An empty row with nothing under it is deleted. Refused:
 *  under a query (the row above may be on another page), for a row carrying
 *  property values (they would fold into another block), and across a nested
 *  table ending the row above, as the outline's Backspace refuses across a
 *  nested surface. */
const mergeRowUp: ActionDispatchDecorator = {
  actionId: 'delete_empty_block_cm',
  context: EDITING,
  wrap: async (deps, trigger, next) => {
    const grid = rowGrid(deps)
    const editDeps = deps as CodeMirrorEditModeDependencies
    const {block, editorView, uiStateBlock, renderScopeId} = editDeps
    const selection = editorView?.state.selection.main
    const aboveId = grid?.rowAbove(block.id)
    if (!grid || !aboveId || !selection?.empty || selection.from !== 0) {
      await next(deps, trigger)
      return
    }
    trigger.preventDefault()
    if (grid.refusesUnderQuery()) return
    if (carriesValues(block)) {
      showInfo('This row has values: merge it in the outline.')
      return
    }
    const {block: into, crossed} = await grid.lastDrawnIn(aboveId)
    const intoData = into.peek()
    const liveContent = editorView!.state.doc.toString()
    // Every child counts, collapsed or not: deleting the row would delete them.
    if (liveContent === '' && (await grid.childIdsOf(block.id)).length === 0) {
      if (!await deleteBlockThroughUi(block)) return
      await focusBlock(uiStateBlock, into.id, {
        edit: true,
        renderScopeId,
        selection: {start: intoData?.content.length ?? 0},
      })
      return
    }
    if (crossed) return
    await mergeUp({from: block, into, liveContent, surface: listingSurfaceOf(editDeps), uiStateBlock})
  },
}

export const tableRowVerbs = [
  splitRow,
  mergeRowUp,
  onRow(EDITING, 'edit.cm.indent_block', (grid, {block}) => grid.nestRow(block.id)),
  onRow(NORMAL, 'indent_block', (grid, {block}) => grid.nestRow(block.id)),
  unnestChild(EDITING, 'edit.cm.outdent_block'),
  unnestChild(NORMAL, 'outdent_block'),
  onRow(EDITING, 'move_block_up_cm', (grid, {block}) => grid.moveRow(block.id, -1)),
  onRow(EDITING, 'move_block_down_cm', (grid, {block}) => grid.moveRow(block.id, 1)),
  onRow(NORMAL, 'move_block_up', (grid, {block}) => grid.moveRow(block.id, -1)),
  onRow(NORMAL, 'move_block_down', (grid, {block}) => grid.moveRow(block.id, 1)),
].map(decorator => actionDispatchWrap(decorator, {source: 'tables', precedence: 100}))
