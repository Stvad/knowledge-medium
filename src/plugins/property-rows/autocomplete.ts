import type {Block} from '@/data/block'
import {ChangeScope, memberCodecOf, type AnyPropertySchema} from '@/data/api'
import {fieldRowDefinition} from './fieldRow'
import {EditorState} from '@codemirror/state'
import {closeCompletion, completionStatus, type CompletionSource} from '@codemirror/autocomplete'
import {EditorView} from '@codemirror/view'
import type {CodeMirrorExtensionContribution, CodeMirrorExtensionContext} from '@/editor/codeMirrorExtensions'
import {flushEditorContent} from '@/editor/contentFlush'
import {canConvertEmptyChildBlockToProperty} from '@/utils/propertyCreation'
import {choosePropertyField, createPropertyField} from '@/data/propertyRowCreation'
import {exitEditModeForBlock, peekFocusedBlockLocation, sameFocusedBlockLocation, uiStateRenderScopeId, focusBlock} from '@/data/properties'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {isPropertyPickerName} from '@/components/propertyPanel/visibility'
import {propertyEditorOverridesFacet} from '@/data/facets'

import {showError} from '@/utils/toast'
import {fieldPlaceholder, focusPlaceholder, focusPickedPlaceholder} from '@/utils/outlinePlaceholderNavigation'

export const OUTLINE_PROPERTY_PRESET_ID = 'string'
type PropertyChoice =
  | {kind: 'existing'; label: string; schema: AnyPropertySchema}
  | {kind: 'create'; label: string; name: string}

const convertChoice = async (owner: Block, source: Block, choice: PropertyChoice, text: string, view: EditorView) => {
  const unchanged = () => view.state.doc.toString() === text
  if (!unchanged() || !await canConvertEmptyChildBlockToProperty(source, owner.repo) || !unchanged()) return
  flushEditorContent(view)
  return choice.kind === 'existing'
    ? choosePropertyField(owner, choice.schema, source, text, unchanged)
    : createPropertyField(owner, source, choice.name, OUTLINE_PROPERTY_PRESET_ID, text, unchanged)
}

const focusChoice = async (context: CodeMirrorExtensionContext & {block: Block}, target: Awaited<ReturnType<typeof convertChoice>>) => {
  const {repo, block, uiStateBlock, renderScopeId} = context
  if (!target || !uiStateBlock || !sameFocusedBlockLocation(peekFocusedBlockLocation(uiStateBlock), {blockId: block.id, renderScopeId: renderScopeId ?? uiStateRenderScopeId(uiStateBlock, block.id)})) return
  await exitEditModeForBlock(uiStateBlock, block.id, renderScopeId)
  if (target.valueId) await enterEditModeForBlock(repo.block(target.valueId), uiStateBlock, renderScopeId)
  else {
    await focusBlock(uiStateBlock, target.fieldRowId, {edit: false, renderScopeId})
    focusPickedPlaceholder(target.fieldRowId, renderScopeId, () => sameFocusedBlockLocation(peekFocusedBlockLocation(uiStateBlock), {blockId: target.fieldRowId, renderScopeId: renderScopeId ?? uiStateRenderScopeId(uiStateBlock, target.fieldRowId)}))
  }
}

export const propertyCompletionSource = (editor: CodeMirrorExtensionContext): CompletionSource => async context => {
  const {repo, block, childBacked} = editor
  const text = context.state.doc.toString()
  if (!childBacked || !block || block.peek()?.isFieldForm || /\(\(|\[\[/.test(text.slice(2)) || !/^::[^\n]*$/.test(text) || context.pos !== text.length || !context.state.selection.main.empty) return null
  const source = await canConvertEmptyChildBlockToProperty(block, repo)
  if (!source) return null
  const name = text.slice(2).trim()
  const query = name.toLowerCase()
  const uis = repo.facetRuntime?.read(propertyEditorOverridesFacet) ?? new Map()
  const hidden = (name: string) => !isPropertyPickerName(name, repo.propertySchemas, uis, repo.propertyDefinitions)
  const rank = (name: string) => name.toLowerCase() === query ? 0 : name.toLowerCase().startsWith(query) ? 1 : 2
  const schemas = [...repo.propertySchemas.values()].filter(schema => schema.changeScope === ChangeScope.BlockDefault && !hidden(schema.name) && schema.name.toLowerCase().includes(query))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).slice(0, 8)
  const candidates: PropertyChoice[] = schemas.map(schema => ({kind: 'existing', label: schema.name, schema}))
  if (context.explicit && name && !hidden(name) && ![...repo.propertySchemas.keys()].some(existing => existing.toLowerCase() === query)) candidates.splice(7, 1, {kind: 'create', label: `Create “${name}”`, name})
  if (!candidates.length) return null
  return {from: 0, filter: false, options: candidates.map(candidate => ({label: candidate.label, apply: (view: EditorView) => {
    closeCompletion(view)
    return convertChoice(repo.block(source.parentId!), block, candidate, text, view)
      .then(target => focusChoice({...editor, block}, target))
      .catch(error => showError(error instanceof Error ? error.message : 'Could not add property'))
  }}))}
}

export const handlePropertyValueEnter = (context: CodeMirrorExtensionContext, event: KeyboardEvent, view: EditorView): boolean => {
    const {block, repo, uiStateBlock, renderScopeId} = context
    if (event.key !== 'Enter' || event.defaultPrevented || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || repo.isReadOnly || !uiStateBlock) return false
    if (completionStatus(view.state) === 'active') return false
    if (!view.state.selection.main.empty || view.state.selection.main.head !== view.state.doc.length) return false
    const parent = repo.cache.getSnapshot(block!.peek()?.parentId ?? '')
    const field = fieldRowDefinition(repo, repo.propertyDefinitions, parent)
    if (!field?.schema || !memberCodecOf(field.schema.codec)) return false
    const placeholder = fieldPlaceholder(parent!.id, renderScopeId)
    if (!placeholder) return false
    event.preventDefault(); event.stopPropagation(); flushEditorContent(view)
    focusPlaceholder(placeholder)
    return true
}
export const propertyAutocomplete: CodeMirrorExtensionContribution = context => {
  if (!context.block) return []
  const source = propertyCompletionSource(context)
  return [EditorState.languageData.of(() => [{autocomplete: source}]),
    EditorView.domEventHandlers({keydown: (event, view) => handlePropertyValueEnter(context, event, view)})]
}
