import type { Block } from '@/data/block'
import { actionDispatchWrap } from '@/shortcuts/actionDispatch'
import { ActionContextTypes, type CodeMirrorEditModeDependencies } from '@/shortcuts/types'
import { showInfo } from '@/utils/toast'
import { gridInScope } from './registry'

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

/** A row's cells encode values which merging its outline text would fold into a different record. */
export const tableRowVerbs = [actionDispatchWrap({
  actionId: 'delete_empty_block_cm',
  context: ActionContextTypes.EDIT_MODE_CM,
  wrap: async (deps, trigger, next) => {
    const {block, renderScopeId, editorView} = deps as CodeMirrorEditModeDependencies
    const selection = editorView?.state.selection.main
    if (selection?.empty && selection.from === 0 && renderScopeId && block &&
        gridInScope(renderScopeId)?.isRow(block.id) && carriesValues(block)) {
      trigger.preventDefault()
      showInfo('This row has values: merge it in the outline.')
      return
    }
    await next(deps, trigger)
  },
}, {source: 'tables', precedence: 100})]
