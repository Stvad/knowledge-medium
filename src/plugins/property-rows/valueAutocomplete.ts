import {startCompletion, type CompletionSource} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {isEnumCodec, type AnyPropertySchema} from '@/data/api'
import {encodedToValueChildContent, valueChildCodec} from '@/data/propertyChildren'
import {parseExactReferenceBlockContent, tryReferenceBlockContentForId} from '@/data/referenceBlock'
import {SELECT_RESOLVING_ALIASES_FOR_BLOCKS_SQL} from '@/data/internals/kernelQueries'
import {faithfulWikilinkReplacement} from '@/plugins/references/referenceParser'
import type {Repo} from '@/data/repo'
import {acceptCompletionInsert} from '@/editor/contentFlush'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions'
import {referenceTargetTypes} from '@/editor/referenceTargetTypes'
import {rankedTypedReferenceCandidates} from '@/utils/linkTargetAutocomplete'
import {propertyValueTargetTypes} from './valueSchema'

interface ReferenceCandidate {insert: string; label: string; detail?: string}

const propertyReferenceChoices = async (
  repo: Repo, workspaceId: string, query: string, targetTypes: readonly string[],
): Promise<ReferenceCandidate[]> => {
  const limit = 12
  const hits = await rankedTypedReferenceCandidates(repo, {workspaceId, query, targetTypes, limit})
  if (!hits.length) return []
  const aliases = await repo.db.getAll<{id: string; alias: string}>(
    SELECT_RESOLVING_ALIASES_FOR_BLOCKS_SQL, [workspaceId, JSON.stringify(hits.map(hit => hit.id))],
  )
  const matchedLabels = new Map(hits.map(hit => [hit.id, hit.label]))
  const named = new Map<string, {label: string; insert: string}>()
  for (const {id, alias} of aliases) {
    if (named.has(id) && alias !== matchedLabels.get(id)) continue
    const insert = faithfulWikilinkReplacement(alias)?.text
    if (!insert) continue
    // Property projection parses the entire row. Its alias must agree with the inline renderer.
    const parsed = parseExactReferenceBlockContent(insert)
    if (parsed?.kind === 'alias' && parsed.alias === alias) named.set(id, {label: alias, insert})
  }
  const choices: ReferenceCandidate[] = []
  for (const hit of hits) {
    const alias = named.get(hit.id)
    const insert = alias?.insert ?? tryReferenceBlockContentForId(hit.id)
    if (insert) choices.push({label: alias?.label ?? hit.label, detail: hit.detail, insert})
    if (choices.length === limit) break
  }
  return choices
}

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
    apply: (view: EditorView, _completion, from, to) => acceptCompletionInsert(view, {from, to, insert: hit.insert}),
  }))}
}

export const valueAutocomplete: CodeMirrorExtensionContribution = ({repo, block, propertyValueSchema}) => {
  if (!propertyValueSchema) return []
  const codec = valueChildCodec(propertyValueSchema)
  const targetTypes = propertyValueTargetTypes(propertyValueSchema)
  if (!targetTypes.length && !(isEnumCodec(codec) && codec.options.length)) return []
  const source = valueCompletionSource(propertyValueSchema, async (query, types) => {
    const workspaceId = (block?.peek() ?? await block?.load())?.workspaceId
    return workspaceId ? propertyReferenceChoices(repo, workspaceId, query, types) : []
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
