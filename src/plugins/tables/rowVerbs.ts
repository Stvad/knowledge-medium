/** The outline's structural verbs on a table's rows. Each row is the root of
 *  its own scope, so inside a row (its children) the outline's verbs run as
 *  they are, and at a row the outline refuses them. Between rows the grid
 *  decides, by the rows it draws: their order may be a sort's, and a query's
 *  rows live anywhere. */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { merge } from '@/data/mutators'
import { displayScopeOf } from '@/data/propertyDisplayMode'
import { editorSelection, focusBlock, isCollapsedProp } from '@/data/properties'
import { visibleChildIds } from '@/data/visibleChildren'
import { actionDispatchWrap, type ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import { requestEditorFocusIfEditing } from '@/shortcuts/blockActions'
import {
  ActionContextTypes, type ActionContextType, type BaseShortcutDependencies, type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { deleteBlockThroughUi, ensureDeletableThroughUi } from '@/utils/deleteBlockThroughUi'
import { getLastVisibleDescendant } from '@/utils/selection'
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

/** The row's children are drawn under it: not collapsed, and some to draw. */
const showsChildren = async (row: Block, deps: BaseShortcutDependencies) =>
  !(row.peekProperty(isCollapsedProp) ?? false) && (await visibleChildIds(row, displayScopeOf(deps))).length > 0

/** Enter in a row's text, by the outline's own split, with the host as the
 *  scope root: at the end a new row below, or a first child when the row's
 *  children show; mid-text the row splits in two. A query's rows live
 *  anywhere, so there the end makes a new row as "+ New row" does, and a
 *  split is refused. */
const splitRow: ActionDispatchDecorator = {
  actionId: 'split_block_cm',
  context: EDITING,
  wrap: async (deps, trigger, next) => {
    const grid = rowGrid(deps)
    const {block, editorView} = deps as CodeMirrorEditModeDependencies
    if (!grid || !editorView || await showsChildren(block, deps)) {
      await next(deps, trigger)
      return
    }
    const atEnd = editorView.state.selection.main.head === editorView.state.doc.length
    if (grid.hasQuery) {
      if (atEnd) grid.command('insert-below')
      else showInfo('A query table’s row splits in the outline.')
      return
    }
    if (grid.allowsNewRow()) await next({...deps, scopeRootId: grid.host.id}, trigger)
  },
}

/** Shift+Tab on a row's own child: it becomes the row after that row. */
const unnestChild = (context: ActionContextType, actionId: string): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: async (deps, trigger, next) => {
    const {block, renderScopeId, scopeRootId, uiStateBlock} = deps as BlockShortcutDependencies
    const grid = gridDrawing(renderScopeId, block?.id)
    const parentId = block?.peek()?.parentId
    if (!grid || !parentId || parentId !== scopeRootId || !grid.isRow(parentId)) {
      await next(deps, trigger)
      return
    }
    await grid.unnestChild(block.id, parentId)
    requestEditorFocusIfEditing(uiStateBlock)
  },
})

/** Backspace at the start of a row's text: the row merges into the last block
 *  drawn above it (the row above, or that row's last child), as the outline
 *  merges into the previous block. A row carrying property values is not
 *  merged here: the merge would fold its values into another block's. */
const mergeRowUp: ActionDispatchDecorator = {
  actionId: 'delete_empty_block_cm',
  context: EDITING,
  wrap: async (deps, trigger, next) => {
    const grid = rowGrid(deps)
    const editDeps = deps as CodeMirrorEditModeDependencies
    const {block, editorView, uiStateBlock, renderScopeId} = editDeps
    const selection = editorView?.state.selection.main
    const aboveId = grid && block ? grid.rowAbove(block.id) : undefined
    if (!grid || !aboveId || !selection?.empty || selection.from !== 0) {
      await next(deps, trigger)
      return
    }
    trigger.preventDefault()
    if (Object.keys(block.peek()?.properties ?? {}).length > 0) {
      showInfo('This row has values: merge it in the outline.')
      return
    }
    const repo = block.repo
    const scope = displayScopeOf(editDeps)
    const into = await getLastVisibleDescendant(repo.block(aboveId), {scopeRootId: aboveId, scopeRootForcesOpen: false, propertyDisplay: scope})
    const intoData = into.peek() ?? await into.load()
    const joinOffset = intoData?.content.length ?? 0
    const content = editorView!.state.doc.toString()
    const children = await visibleChildIds(block, scope)
    if (content === '' && children.length === 0) {
      if (!await deleteBlockThroughUi(block)) return
    } else {
      if (children.length > 0 && into.id !== aboveId && (await visibleChildIds(into, scope)).length > 0) return
      if (!await ensureDeletableThroughUi([block])) return
      await repo.tx(async tx => {
        await tx.update(block.id, {content})
        await tx.run(merge, {intoId: into.id, fromId: block.id})
      }, {scope: ChangeScope.BlockDefault, description: 'merge table row into the block above'})
    }
    await uiStateBlock.set(editorSelection, {blockId: into.id, start: joinOffset})
    await focusBlock(uiStateBlock, into.id, {edit: true, renderScopeId})
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
