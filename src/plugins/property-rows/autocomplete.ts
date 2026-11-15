import {memberCodecOf} from '@/data/api'
import {fieldRowDefinition} from './fieldRow'
import {EditorState} from '@codemirror/state'
import type {CompletionSource} from '@codemirror/autocomplete'
import {EditorView} from '@codemirror/view'
import type {CodeMirrorExtensionContribution, CodeMirrorExtensionContext} from '@/editor/codeMirrorExtensions'
import {flushEditorContent} from '@/editor/contentFlush'
import {readIsChildBackedWorkspace} from '@/data/workspaceSchema'
import {canConvertEmptyChildBlockToProperty} from '@/utils/propertyCreation'
import {choosePropertyField} from '@/data/propertyRowCreation'
import {focusBlock} from '@/data/properties'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {DEFAULT_PRESET_ID} from '@/components/propertyPanel/PropertyPicker'
import {showError} from '@/utils/toast'

export const propertyCompletionSource = ({repo, block, uiStateBlock, renderScopeId}: CodeMirrorExtensionContext): CompletionSource => async context => {
  const text = context.state.doc.toString()
  if (!block || !/^::[^\n]*$/.test(text) || context.pos !== text.length || !context.state.selection.main.empty) return null
  const source = await canConvertEmptyChildBlockToProperty(block, repo)
  if (!source || !await readIsChildBackedWorkspace(repo.db, source.workspaceId)) return null
  const name = text.slice(2).trim()
  const schemas = [...repo.propertySchemas.values()].filter(schema => schema.name.toLowerCase().includes(name.toLowerCase()))
  const candidates = schemas.map(schema => ({label: schema.name, schema}))
  if (name && !repo.propertySchemas.has(name)) candidates.push({label: `Create “${name}”`, schema: undefined!})
  return {from: 0, filter: false, options: candidates.map(candidate => ({label: candidate.label, apply: (view: EditorView) => {
    if (view.state.doc.toString() !== text) return
    void (async () => {
      if (!await canConvertEmptyChildBlockToProperty(block, repo) || view.state.doc.toString() !== text) return
      flushEditorContent(view)
      const schema = candidate.schema ?? await repo.userSchemas.addSchema({name, presetId: DEFAULT_PRESET_ID})
      if (view.state.doc.toString() !== text) return
      const target = await choosePropertyField(repo.block(source.parentId!), schema, block, text)
      if (!uiStateBlock) return
      if (target.valueId) await enterEditModeForBlock(repo.block(target.valueId), uiStateBlock, renderScopeId)
      else {
        await focusBlock(uiStateBlock, target.fieldRowId, {edit: false, renderScopeId})
      }
    })().catch(error => showError(error instanceof Error ? error.message : 'Could not add property'))
  }}))}
}

export const propertyAutocomplete: CodeMirrorExtensionContribution = context => context.block
  ? [EditorState.languageData.of(() => [{autocomplete: propertyCompletionSource(context)}]), EditorView.domEventHandlers({keydown: (event, view) => {
    const {block, repo, uiStateBlock, renderScopeId} = context
    if (event.key !== 'Enter' || event.defaultPrevented || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || repo.isReadOnly || !uiStateBlock) return false
    if (!view.state.selection.main.empty || view.state.selection.main.head !== view.state.doc.length) return false
    const parent = repo.cache.getSnapshot(block!.peek()?.parentId ?? '')
    const field = fieldRowDefinition(repo, repo.propertyDefinitions, parent)
    if (!field?.schema || !memberCodecOf(field.schema.codec)) return false
    event.preventDefault(); event.stopPropagation(); flushEditorContent(view)
    void focusBlock(uiStateBlock, parent!.id, {edit: false, renderScopeId})
    return true
  }})]
  : []
