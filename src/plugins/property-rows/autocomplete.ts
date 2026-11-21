import {Block} from '@/data/block'
import {ChangeScope, type AnyPropertySchema} from '@/data/api'
import {EditorState} from '@codemirror/state'
import {closeCompletion, type CompletionSource} from '@codemirror/autocomplete'
import {EditorView} from '@codemirror/view'
import type {CodeMirrorExtensionContribution, CodeMirrorExtensionContext} from '@/editor/codeMirrorExtensions'
import {flushEditorContent} from '@/editor/contentFlush'
import {canConvertEmptyChildBlockToProperty} from '@/utils/propertyCreation'
import {choosePropertyField, createPropertyField} from '@/data/propertyRowCreation'
import {exitEditModeForBlock, getBlockTypes, peekFocusedBlockLocation, sameFocusedBlockLocation, uiStateRenderScopeId} from '@/data/properties'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {isPropertyPickerName} from '@/components/propertyPanel/visibility'
import {propertyEditorOverridesFacet} from '@/data/facets'
import {typePropertyGroups} from '@/data/typePropertyGroups'

import {showError} from '@/utils/toast'

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
  const valueId = target.valueId ?? await repo.mutate.createChild({parentId: target.fieldRowId, revealParent: true})
  await enterEditModeForBlock(repo.block(valueId), uiStateBlock, renderScopeId)
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
  const schemas = [...repo.propertySchemas.values()].filter(schema => schema.changeScope === ChangeScope.BlockDefault && !hidden(schema.name) && schema.name.toLowerCase().includes(query))
  const missing = new Set<string>()
  const owner = await repo.load(source.parentId!)
  if (owner) {
    const declared = new Set([...typePropertyGroups(getBlockTypes(owner), repo.types, repo.propertySchemas)]
      .flatMap(group => group.fields.map(({schema}) => schema.name)))
    const unfilled = schemas.filter(schema => declared.has(schema.name) && !Object.hasOwn(owner.properties, schema.name))
    if (unfilled.length) {
      const children = await repo.query.children({id: owner.id, propertyChildren: 'all'}).load()
      const existingFields = new Set(children.filter(row => row.isFieldForm).map(row => row.referenceTargetId))
      const resolver = repo.propertySchemaResolverFor(owner.workspaceId)
      for (const schema of unfilled) {
        const resolved = resolver.resolve(schema.name)
        if (resolved.status === 'resolved' && !existingFields.has(resolved.schema.fieldId)) missing.add(schema.name)
      }
    }
  }
  // Exact names win; missing declared fields precede other prefix/substring matches.
  const rank = (name: string) => {
    const normalized = name.toLowerCase()
    if (normalized === query) return 0
    return (missing.has(name) ? 1 : 3) + (normalized.startsWith(query) ? 0 : 1)
  }
  const candidates: PropertyChoice[] = schemas
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).slice(0, 8)
    .map(schema => ({kind: 'existing', label: schema.name, schema}))
  if (name && !hidden(name) && ![...repo.propertySchemas.keys()].some(existing => existing.toLowerCase() === query)) candidates.splice(7, 1, {kind: 'create', label: `Create “${name}”`, name})
  if (!candidates.length) return null
  return {from: 0, filter: false, options: candidates.map(candidate => ({label: candidate.label, apply: (view: EditorView) => {
    closeCompletion(view)
    return repo.undoGroup(async grouped => {
      const target = await convertChoice(new Block(grouped, source.parentId!), new Block(grouped, block.id), candidate, text, view)
      await focusChoice({...editor, repo: grouped, block}, target)
    })
      .catch(error => showError(error instanceof Error ? error.message : 'Could not add property'))
  }}))}
}

export const propertyAutocomplete: CodeMirrorExtensionContribution = context => {
  if (!context.block || context.disableStructuralCompletions) return []
  const source = propertyCompletionSource(context)
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
