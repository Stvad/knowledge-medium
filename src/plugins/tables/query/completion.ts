/** Completion inside a table's query. In the query property's value, inside its
 *  fence, `#` offers the workspace's types and a word starting a term offers
 *  its property and field keys; accepting one inserts query text and writes
 *  nothing else. The fence is literal markdown, where the `#` type tag is off
 *  (`isInsideLiteralMarkdown`, the same test), so a pick here can never tag the
 *  value block or mint a type. Outside the fence the value is an ordinary
 *  block, `#` included.
 *
 *  A pick inserts the saved form (`#label^typeId`, `name^fieldId`): the
 *  completion knows which definition was picked, and the id keeps the term on
 *  it through a rename or a second type with the same label. */
import type { CompletionSource } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isPropertyPickerName } from '@/components/propertyPanel/visibility'
import type { Block } from '@/data/block'
import { propertyEditorOverridesFacet, queryableFieldsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions'
import { acceptCompletionInsert } from '@/editor/contentFlush'
import { isInsideLiteralMarkdown } from '@/editor/syntaxContext'
import { queryProp } from '../schema'
import { formatTerm, word } from './format'
import { BREAK, RESERVED_KEYS, parseQuery, takesOperand, type QueryResolver, type QueryType } from './parse'
import { queryResolver } from './source'

/** A term starts at the line start or after whitespace, `|` or a negating `!`;
 *  its name runs to the cursor in the parser's bare-word characters. */
const TRIGGER = new RegExp(String.raw`(?:^|[\s|!])(#?)((?:(?!${BREAK.source}).)*)$`)

export interface QueryTrigger {
  readonly kind: 'type' | 'key'
  /** Offset in the line where the inserted text starts: the `#`, or the key's first character. */
  readonly from: number
  readonly query: string
}

/** Whether `text` ends inside an open `"…"`. */
const endsInQuote = (text: string): boolean => {
  let open = false
  for (let i = 0; i < text.length; i++) {
    if (open && text[i] === '\\') i++
    else if (text[i] === '"') open = !open
  }
  return open
}

/** The term name being typed at `col`, or null: not at a term's start, in the
 *  middle of a word, inside a quote, or an empty key. */
export const queryTriggerAt = (line: string, col: number): QueryTrigger | null => {
  const next = line[col]
  if (next !== undefined && !BREAK.test(next)) return null
  const prefix = line.slice(0, col)
  const match = TRIGGER.exec(prefix)
  if (!match) return null
  const [, hash, query] = match as unknown as [string, string, string]
  const from = col - hash.length - query.length
  if ((!hash && !query) || endsInQuote(prefix.slice(0, from))) return null
  return {kind: hash ? 'type' : 'key', from, query}
}

export interface QueryCompletion {
  readonly label: string
  readonly detail: 'type' | 'property' | 'field' | 'structure'
  readonly insert: string
}

/** What a query can name, before the resolver vets it. */
export interface QueryVocabulary {
  readonly types: readonly QueryType[]
  readonly propertyNames: readonly string[]
  readonly fieldNames: readonly string[]
}

const RESULT_CAP = 12

/** Labels containing the query, an exact match first, then prefixes, then the rest. */
const ranked = <T,>(items: readonly T[], labelOf: (item: T) => string, query: string): T[] => {
  const q = query.toLowerCase()
  const rank = (label: string) => label === q ? 0 : label.startsWith(q) ? 1 : 2
  return items
    .filter(item => labelOf(item).toLowerCase().includes(q))
    .sort((a, b) => rank(labelOf(a).toLowerCase()) - rank(labelOf(b).toLowerCase()) || labelOf(a).localeCompare(labelOf(b)))
}

const parsesClean = (text: string, resolver: QueryResolver) => parseQuery(text, resolver).errors.length === 0

const typeCompletion = (type: QueryType, resolver: QueryResolver): QueryCompletion | undefined => {
  const insert = formatTerm({kind: 'types', negated: false, types: [type], start: 0, end: 0})
  return parsesClean(insert, resolver) ? {label: type.label, detail: 'type', insert} : undefined
}

type Key = {kind: 'property' | 'field' | 'structure'; name: string}

const keyCompletion = ({kind, name}: Key, resolver: QueryResolver): QueryCompletion | undefined => {
  if (kind === 'structure') return {label: name, detail: 'structure', insert: `${name}=`}
  if (kind === 'field') return resolver.field(name) ? {label: name, detail: 'field', insert: `${word(name)}=`} : undefined
  const property = resolver.propertyByName(name)
  if (!property) return undefined
  const key = formatTerm({kind: 'presence', property, present: true, start: 0, end: 0})
  // A property named like a field is a term error however it is addressed.
  if (!parsesClean(key, resolver)) return undefined
  return {label: name, detail: 'property', insert: takesOperand(property.schema) ? `${key}=` : key}
}

/** The completions for a trigger, each vetted by parsing its text with the resolver the table parses with. */
export const queryCompletions = (trigger: QueryTrigger, vocabulary: QueryVocabulary, resolver: QueryResolver): QueryCompletion[] => {
  const vetted = <T,>(items: readonly T[], labelOf: (item: T) => string, complete: (item: T) => QueryCompletion | undefined) => {
    const out: QueryCompletion[] = []
    for (const item of ranked(items, labelOf, trigger.query)) {
      const completion = complete(item)
      if (completion) out.push(completion)
      if (out.length === RESULT_CAP) break
    }
    return out
  }
  if (trigger.kind === 'type') return vetted(vocabulary.types, type => type.label, type => typeCompletion(type, resolver))
  const keys: Key[] = [
    ...vocabulary.propertyNames.map(name => ({kind: 'property' as const, name})),
    ...vocabulary.fieldNames.map(name => ({kind: 'field' as const, name})),
    ...RESERVED_KEYS.map(name => ({kind: 'structure' as const, name})),
  ]
  return vetted(keys, key => key.name, key => keyCompletion(key, resolver))
}

/** The workspace's vocabulary, as the property picker and the parser see it. */
const vocabularyOf = (repo: Repo, workspaceId: string): QueryVocabulary => {
  const definitions = repo.propertyDefinitions
  const uis = repo.facetRuntime?.read(propertyEditorOverridesFacet) ?? new Map()
  return {
    types: [...repo.types.values()].map(type => ({id: type.id, label: type.label ?? type.id})),
    propertyNames: [...definitions?.definitionsByName.keys() ?? []]
      .filter(name => isPropertyPickerName(name, repo.propertySchemas, uis, definitions)),
    fieldNames: [...repo.facetRuntime?.read(queryableFieldsFacet, workspaceId)?.keys() ?? []],
  }
}

export const queryCompletionSource = (repo: Repo, block: Block): CompletionSource => async context => {
  const {state, pos} = context
  if (!state.selection.main.empty || !isInsideLiteralMarkdown(state, pos)) return null
  const line = state.doc.lineAt(pos)
  const trigger = queryTriggerAt(line.text, pos - line.from)
  const workspaceId = block.peek()?.workspaceId
  if (!trigger || !workspaceId) return null
  const resolver = queryResolver(repo, workspaceId, repo.propertyDefinitions, repo.types, new Map())
  const completions = queryCompletions(trigger, vocabularyOf(repo, workspaceId), resolver)
  if (completions.length === 0) return null
  return {
    from: line.from + trigger.from,
    to: pos,
    // Ranked and matched here; CodeMirror's filter would match the label against `#…`.
    filter: false,
    options: completions.map(completion => ({
      label: completion.label,
      detail: completion.detail,
      type: completion.detail === 'type' ? 'class' : 'property',
      apply: (view: EditorView, _option, from: number, to: number) => acceptCompletionInsert(view, {from, to, insert: completion.insert}),
    })),
  }
}

/** Only the query property's value: a fence anywhere else is not a query. */
export const queryCompletionExtension: CodeMirrorExtensionContribution = ({repo, block, propertyValueSchema}) => {
  if (!block || propertyValueSchema?.name !== queryProp.name) return []
  const source = queryCompletionSource(repo, block)
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
