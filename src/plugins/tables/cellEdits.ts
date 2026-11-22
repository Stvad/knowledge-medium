/** Where a cell edit ends. Every way out of a cell's editor (Enter, Tab,
 *  Escape, a click elsewhere, the table going away) unmounts it, so its
 *  teardown is the one place that calls `finishPropertyValueEdit`, with the
 *  editor's final text. */
import { ViewPlugin } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import {
  PropertyEditRefusedError, finishPropertyValueEdit, type OpenedPropertyValue,
} from '@/data/internals/propertyValueEdits'
import { isEditingBlock } from '@/data/properties'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions'
import { surfaceOfRenderScopeId } from '@/utils/renderScope'
import type { Repo } from '@/data/repo'
import { showError } from '@/utils/toast'
import { TABLE_SURFACE, isGridMounted } from './registry'

/** Show a refusal to the user; any other error is a real failure and propagates. */
export const reportRefusal = (error: unknown) => {
  if (!(error instanceof PropertyEditRefusedError)) throw error
  showError(error.message)
}

/** The owner and property of a value row, read from the cache: value → field row → owner. */
export const peekValueOwner = (repo: Repo, valueId: string): {ownerId: string; fieldId: string} | undefined => {
  const fieldRowId = repo.block(valueId).peek()?.parentId
  const field = fieldRowId ? repo.block(fieldRowId).peek() : undefined
  return field?.parentId && field.referenceTargetId ? {ownerId: field.parentId, fieldId: field.referenceTargetId} : undefined
}

const opened = new Map<string, OpenedPropertyValue>()
const editKey = (valueId: string, renderScopeId: string) => `${renderScopeId}\u0000${valueId}`

/** Remember what `openPropertyValue` returned: only that result lets finishing
 *  remove a draft it created. */
export const openedCellEdit = (edit: OpenedPropertyValue, renderScopeId: string): void => {
  opened.set(editKey(edit.valueId, renderScopeId), edit)
}

export const forgetCellEdit = (valueId: string, renderScopeId: string): void => {
  opened.delete(editKey(valueId, renderScopeId))
}

export const cellEditorExtension: CodeMirrorExtensionContribution = context => {
  const {block, uiStateBlock, renderScopeId, propertyValueSchema} = context
  if (!block || !uiStateBlock || !renderScopeId || !propertyValueSchema) return []
  if (surfaceOfRenderScopeId(renderScopeId) !== TABLE_SURFACE) return []
  const repo = block.repo
  return [ViewPlugin.define(view => ({
    destroy() {
      const finalText = view.state.doc.toString()
      // A remount (StrictMode, a reconfigure) destroys the view while the value
      // is still being edited in a mounted table; any other teardown ends the edit.
      setTimeout(() => {
        if (isEditingBlock(uiStateBlock, block.id, renderScopeId) && isGridMounted(renderScopeId)) return
        const key = editKey(block.id, renderScopeId)
        const edit = opened.get(key) ?? block.id
        opened.delete(key)
        const owner = peekValueOwner(repo, block.id)
        if (!owner) return
        void repo.tx(tx => finishPropertyValueEdit(tx, owner.ownerId, owner.fieldId, edit, finalText),
          {scope: ChangeScope.BlockDefault, description: 'finish table cell edit'})
          .catch(reportRefusal)
      })
    },
  }))]
}
