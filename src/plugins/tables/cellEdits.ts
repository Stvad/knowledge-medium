/** Where a cell edit ends. Every way out of a cell's editor (Enter, Tab,
 *  Escape, a click elsewhere) unmounts it, so its teardown is the one place
 *  that calls `finishPropertyValueEdit`, with the editor's final text. */
import { ViewPlugin } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import {
  PropertyEditRefusedError, finishPropertyValueEdit, type OpenedPropertyValue,
} from '@/data/internals/propertyValueEdits'
import { isEditingBlock } from '@/data/properties'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions'
import { surfaceOfRenderScopeId } from '@/utils/renderScope'
import { showError } from '@/utils/toast'

export const TABLE_SURFACE = 'tables'

const opened = new Map<string, OpenedPropertyValue>()
const editKey = (valueId: string, renderScopeId: string) => `${renderScopeId}\u0000${valueId}`

/** Remember what `openPropertyValue` returned: only that result lets finishing
 *  remove a draft it created. */
export const openedCellEdit = (edit: OpenedPropertyValue, renderScopeId: string): void => {
  opened.set(editKey(edit.valueId, renderScopeId), edit)
}

export const cellEditorExtension: CodeMirrorExtensionContribution = context => {
  const {block, uiStateBlock, renderScopeId, propertyValueSchema} = context
  if (!block || !uiStateBlock || !renderScopeId || !propertyValueSchema) return []
  if (surfaceOfRenderScopeId(renderScopeId) !== TABLE_SURFACE) return []
  const repo = block.repo
  return [ViewPlugin.define(view => ({
    destroy() {
      const finalText = view.state.doc.toString()
      // A remount (StrictMode, a reconfigure) destroys the view while the
      // value is still being edited; only a real exit leaves edit mode.
      setTimeout(() => {
        if (isEditingBlock(uiStateBlock, block.id, renderScopeId)) return
        const key = editKey(block.id, renderScopeId)
        const edit = opened.get(key) ?? block.id
        opened.delete(key)
        const fieldRowId = block.peek()?.parentId
        const field = fieldRowId ? repo.block(fieldRowId).peek() : undefined
        if (!field?.parentId || !field.referenceTargetId) return
        const ownerId = field.parentId
        const fieldId = field.referenceTargetId
        void repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, edit, finalText),
          {scope: ChangeScope.BlockDefault, description: 'finish table cell edit'})
          .catch(error => {
            if (!(error instanceof PropertyEditRefusedError)) throw error
            showError(error.message)
          })
      })
    },
  }))]
}
