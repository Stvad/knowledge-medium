import {startCompletion, type CompletionSource} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {isEnumCodec, type AnyPropertySchema} from '@/data/api'
import {encodedToValueChildContent, valueChildCodec} from '@/data/propertyChildren'
import {parseExactReferenceBlockContent, tryReferenceBlockContentForId} from '@/data/referenceBlock'
import {SELECT_RESOLVING_ALIASES_FOR_BLOCK_SQL} from '@/data/internals/kernelQueries'
import {faithfulWikilinkReplacement} from '@/plugins/references/referenceParser'
import type {Repo} from '@/data/repo'
import {acceptCompletionInsert} from '@/editor/contentFlush'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions'
import {referenceTargetTypes} from '@/editor/referenceTargetTypes'
import {rankedTypedReferenceCandidates} from '@/utils/linkTargetAutocomplete'
import {showError} from '@/utils/toast'
import {propertyValueTargetTypes} from './valueSchema'

interface ReferenceCandidate {
  label: string
  detail?: string
  resolveContent: () => Promise<string | null>
}

const propertyReferenceChoices = async (
  repo: Repo, workspaceId: string, query: string, targetTypes: readonly string[],
): Promise<ReferenceCandidate[]> => {
  const limit = 12
  const hits = await rankedTypedReferenceCandidates(repo, {workspaceId, query, targetTypes, limit})
  const choices: ReferenceCandidate[] = []
  for (const hit of hits) {
    const fallback = tryReferenceBlockContentForId(hit.id)
    const resolveContent = async () => {
      const aliases = await repo.db.getAll<{alias: string}>(SELECT_RESOLVING_ALIASES_FOR_BLOCK_SQL, [workspaceId, hit.id, hit.label])
      for (const {alias} of aliases) {
        const text = faithfulWikilinkReplacement(alias)?.text
        if (!text) continue
        const parsed = parseExactReferenceBlockContent(text)
        if (parsed?.kind === 'alias' && parsed.alias === alias) return text
      }
      return fallback
    }
    // Only targets with no ID spelling need an alias check before they can be offered.
    if (fallback || await resolveContent()) choices.push({label: hit.label, detail: hit.detail, resolveContent})
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
    apply: async (view: EditorView, _completion, from, to) => {
      const {doc, selection} = view.state
      try {
        const insert = await hit.resolveContent()
        if (!view.dom.isConnected || view.state.doc !== doc || !view.state.selection.eq(selection)) return
        if (insert === null) {
          showError('This block no longer has a usable reference.')
          return
        }
        acceptCompletionInsert(view, {from, to, insert})
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Could not resolve the reference.')
      }
    },
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
