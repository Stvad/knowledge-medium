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

/** The owner and property of a live value row, read from the cache: value → field row → owner. */
export const peekValueOwner = (repo: Repo, valueId: string): {ownerId: string; fieldId: string} | undefined => {
  const value = repo.block(valueId).peek()
  const field = value?.parentId ? repo.block(value.parentId).peek() : undefined
  return field?.isFieldForm && field.parentId && field.referenceTargetId
    ? {ownerId: field.parentId, fieldId: field.referenceTargetId} : undefined
}

interface OpenedCellEdit {
  edit: OpenedPropertyValue
  ownerId: string
  fieldId: string
}

const opened = new Map<string, OpenedCellEdit>()
const editKey = (valueId: string, renderScopeId: string) => `${renderScopeId}\u0000${valueId}`

/** Remember what `openPropertyValue` returned, and for which property: only
 *  that result lets finishing remove a draft it created, also once the draft
 *  itself is gone. */
export const openedCellEdit = (edit: OpenedPropertyValue, ownerId: string, fieldId: string, renderScopeId: string): void => {
  opened.set(editKey(edit.valueId, renderScopeId), {edit, ownerId, fieldId})
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
      // is still being edited in a mounted table; any other teardown ends the
      // edit. A deleted value is not remounting, though focus may still name it.
      setTimeout(() => {
        if (block.peek() && isEditingBlock(uiStateBlock, block.id, renderScopeId) && isGridMounted(renderScopeId)) return
        const key = editKey(block.id, renderScopeId)
        const draft = opened.get(key)
        opened.delete(key)
        // A value the outline nested under another member is no longer an edit
        // of this property. One it deleted blank (Backspace) still finishes, so
        // the field its draft created goes too.
        const owner = peekValueOwner(repo, block.id) ?? (draft && finalText === '' ? draft : undefined)
        if (!owner) return
        const edit = draft?.edit ?? block.id
        void repo.tx(tx => finishPropertyValueEdit(tx, owner.ownerId, owner.fieldId, edit, finalText),
          {scope: ChangeScope.BlockDefault, description: 'finish table cell edit'})
          .catch(reportRefusal)
      })
    },
  }))]
}
