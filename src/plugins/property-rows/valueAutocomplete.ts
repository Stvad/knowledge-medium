import {startCompletion, type CompletionSource} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {isEnumCodec, type AnyPropertySchema} from '@/data/api'
import {encodedToValueChildContent, valueChildCodec} from '@/data/propertyChildren'
import {referenceBlockContentForId} from '@/data/referenceBlock'
import {acceptCompletionInsert} from '@/editor/contentFlush'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions'
import {referenceTargetTypes} from '@/editor/referenceTargetTypes'
import {searchTypedReferenceCandidates} from '@/utils/linkTargetAutocomplete'
import {propertyValueTargetTypes} from './valueSchema'

interface ReferenceCandidate {id: string; label: string; detail?: string}

export const valueCompletionSource = (
  schema: AnyPropertySchema,
  search: (query: string, targetTypes: readonly string[]) => Promise<ReferenceCandidate[]>,
): CompletionSource => async context => {
  const text = context.state.doc.toString()
  if (context.pos !== text.length || !context.state.selection.main.empty || /\n|\[\[|\(\(/.test(text)) return null
  const codec = valueChildCodec(schema)
  if (isEnumCodec(codec)) {
    const query = text.trim().toLowerCase()
    const options = codec.options.filter(option => option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))
    if (!options.length) return null
    return {from: 0, filter: false, options: options.map(option => ({
      label: option.label,
      detail: option.label === option.value ? undefined : option.value,
      apply: (view: EditorView, _completion, from, to) => acceptCompletionInsert(view, {from, to, insert: encodedToValueChildContent(schema, option.value)}),
    }))}
  }
  const targetTypes = propertyValueTargetTypes(schema)
  if (!targetTypes.length) return null
  const hits = await search(text, targetTypes)
  if (!hits.length) return null
  return {from: 0, filter: false, options: hits.map(hit => ({
    label: hit.label,
    detail: hit.detail === hit.label ? undefined : hit.detail,
    apply: (view: EditorView, _completion, from, to) => acceptCompletionInsert(view, {from, to, insert: referenceBlockContentForId(hit.id)}),
  }))}
}

export const valueAutocomplete: CodeMirrorExtensionContribution = ({repo, block, propertyValueSchema}) => {
  if (!propertyValueSchema) return []
  const codec = valueChildCodec(propertyValueSchema)
  const targetTypes = propertyValueTargetTypes(propertyValueSchema)
  if (!isEnumCodec(codec) && !targetTypes.length) return []
  const source = valueCompletionSource(propertyValueSchema, async (query, types) => {
    const workspaceId = (block?.peek() ?? await block?.load())?.workspaceId
    return workspaceId ? searchTypedReferenceCandidates(repo, {workspaceId, query, targetTypes: types, limit: 12}) : []
  })
  return [
    ...(targetTypes.length ? [referenceTargetTypes.of(targetTypes)] : []),
    EditorState.languageData.of(() => [{autocomplete: source}]),
    EditorView.domEventHandlers({focus: (_event, view) => {
      queueMicrotask(() => {
        if (view.hasFocus && view.state.doc.length === 0) startCompletion(view)
      })
    }}),
  ]
}
