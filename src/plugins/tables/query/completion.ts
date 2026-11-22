/** Completion inside a table's query. In the query property's value, inside its
 *  fence, `#` offers the workspace's types and a word starting a term offers
 *  its property and field keys; accepting one inserts query text and writes
 *  nothing else. The fence is literal markdown, where the `#` type tag is off
 *  (`isInsideLiteralMarkdown`, the same test), so a pick here can never tag the
 *  value block or mint a type. Outside the fence the value is an ordinary
 *  block, `#` included.
 *
 *  A pick inserts the name alone where the parser resolves that name to the
 *  picked definition, for readable text; where it would not (a second type
 *  with the same label, a property named like a structural key) it inserts the
 *  saved form, `#label^typeId` or `name^fieldId`. */
import type { CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
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
import { propertyKey, propertyName, typeName, typeRef } from './format'
import {
  BREAK, RESERVED_KEYS, closingQuote, isPropertyAndField, isReservedKey, takesOperand, type QueryResolver, type QueryType,
} from './parse'
import { queryResolver } from './source'

const WORD = String.raw`(?:(?!${BREAK.source}).)*`
/** A term starts at the text start, after whitespace, `|` or a group's `(`,
 *  with an optional negating `!`, then a `#type` or a key, up to the cursor: a
 *  bare word, or a type label still inside its opening quote. */
const TERM_BEFORE = new RegExp(String.raw`(^|[\s|(])(!?)(?:(#?)(${WORD})|#"((?:[^"\\]|\\.)*))$`)
const WORD_AFTER = new RegExp(`^${WORD}`)
const OPERATOR_AFTER = /^(?:!=|<=|>=|=|<|>)/

/** Whether `text` ends inside an operand: an open quote, `[…]` (a `[[page]]` or
 *  a link's label), or a `((block id))`. A term never starts there. */
const endsInOperand = (text: string): boolean => {
  let brackets = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') brackets++
    else if (text[i] === ']') brackets = Math.max(0, brackets - 1)
    else if (brackets > 0) continue
    else if (text[i] === '"') {
      i = closingQuote(text, i)
      if (i < 0) return true
    } else if (text.startsWith('((', i)) {
      i = text.indexOf('))', i + 2) + 1
      if (i <= 0) return true
    }
  }
  return brackets > 0
}

/** How far a term's name runs past the cursor: the rest of its word or quote, and a saved `^id`. */
const nameEndAfter = (after: string, quoted: boolean): number => {
  const close = quoted ? closingQuote(`"${after}`, 0) : -1
  let end = quoted ? (close < 0 ? after.length : close) : WORD_AFTER.exec(after)![0].length
  if (after[end] !== '^') return end
  end++
  if (after[end] !== '"') return end + WORD_AFTER.exec(after.slice(end))![0].length
  const idClose = closingQuote(after, end)
  return idClose < 0 ? after.length : idClose + 1
}

export interface QueryTrigger {
  readonly kind: 'type' | 'key'
  /** The replaced range, as offsets into `before + after`: the `#` or the key's first character, to the end of the name. */
  readonly from: number
  readonly to: number
  /** What is typed of the name, up to the cursor. */
  readonly query: string
  readonly negated: boolean
  /** One side of a `|` group, where a negated or `childof=` term cannot stand. */
  readonly alternative: boolean
  /** An operator already follows the name, so a pick adds none. */
  readonly operatorFollows: boolean
}

/** The term whose name is being typed at the cursor, or null where no term starts.
 *  `before` is the query text up to the cursor, `after` the rest of its line. */
export const queryTriggerAt = (before: string, after = ''): QueryTrigger | null => {
  const match = TERM_BEFORE.exec(before)
  if (!match) return null
  const [, lead = '', bang = '', hash = '', bare, quotedLabel] = match
  const quoted = quotedLabel !== undefined
  const query = quoted ? quotedLabel.replace(/\\(.)/g, '$1') : bare ?? ''
  const from = quoted ? before.length - quotedLabel.length - 2 : before.length - hash.length - query.length
  if ((!quoted && !hash && !query) || endsInOperand(before.slice(0, from))) return null
  const end = nameEndAfter(after, quoted)
  return {
    kind: quoted || hash ? 'type' : 'key',
    from,
    to: before.length + end,
    query,
    negated: bang === '!',
    alternative: lead === '|' || lead === '(' || before.slice(0, from - bang.length).trimEnd().endsWith('|'),
    operatorFollows: OPERATOR_AFTER.test(after.slice(end)),
  }
}

interface QueryCompletion {
  readonly label: string
  readonly detail: string
  readonly insert: string
}

interface OfferedType extends QueryType {
  /** Kernel and plugin plumbing (`hideFromCompletion`): still queryable, offered after the rest. */
  readonly plumbing: boolean
}

/** What a query can name in this workspace, as the parser resolves it. */
interface QueryVocabulary {
  readonly types: readonly OfferedType[]
  readonly propertyNames: readonly string[]
  readonly fieldNames: readonly string[]
}

const RESULT_CAP = 12

/** Labels containing the query: an exact match first, then prefixes, then the
 *  rest; within each, the `later` items after the others. */
const ranked = <T,>(items: readonly T[], labelOf: (item: T) => string, query: string, later: (item: T) => boolean = () => false): T[] => {
  const q = query.toLowerCase()
  const rank = (label: string) => label === q ? 0 : label.startsWith(q) ? 1 : 2
  return items
    .map(item => ({item, label: labelOf(item), rank: rank(labelOf(item).toLowerCase()) * 2 + (later(item) ? 1 : 0)}))
    .filter(({label}) => label.toLowerCase().includes(q))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({item}) => item)
}

const typeCompletions = (types: readonly OfferedType[], query: string, resolver: QueryResolver): QueryCompletion[] => {
  const picks = ranked(types, type => type.label, query, type => type.plumbing).slice(0, RESULT_CAP)
  // Types sharing a label are told apart by their ids.
  const shared = (type: QueryType) => picks.some(other => other !== type && other.label === type.label)
  return picks.map(type => ({
    label: type.label,
    detail: shared(type) ? type.id : 'type',
    insert: resolver.typeByLabel(type.label)?.id === type.id ? typeName(type) : typeRef(type),
  }))
}

const keyCompletions = (trigger: QueryTrigger, vocabulary: QueryVocabulary, resolver: QueryResolver): QueryCompletion[] => {
  const operator = (takes: boolean) => takes && !trigger.negated && !trigger.operatorFollows ? '=' : ''
  const keys: QueryCompletion[] = []
  for (const name of vocabulary.propertyNames) {
    const property = resolver.propertyByName(name)
    if (!property || isPropertyAndField(resolver, name)) continue
    const key = isReservedKey(name) ? propertyKey(property) : propertyName(property)
    keys.push({label: name, detail: 'property', insert: key + operator(takesOperand(property.schema))})
  }
  // A negated key can only test a property's presence.
  if (!trigger.negated) {
    for (const name of vocabulary.fieldNames) {
      if (!isPropertyAndField(resolver, name)) keys.push({label: name, detail: 'field', insert: name + operator(true)})
    }
    for (const name of RESERVED_KEYS) {
      if (!(trigger.alternative && name === 'childof')) keys.push({label: name, detail: 'structure', insert: name + operator(true)})
    }
  }
  return ranked(keys, key => key.label, trigger.query).slice(0, RESULT_CAP)
}

const queryCompletions = (trigger: QueryTrigger, vocabulary: QueryVocabulary, resolver: QueryResolver): QueryCompletion[] => {
  if (trigger.negated && trigger.alternative) return []
  return trigger.kind === 'type' ? typeCompletions(vocabulary.types, trigger.query, resolver) : keyCompletions(trigger, vocabulary, resolver)
}

/** The workspace's vocabulary, as the property picker and the parser see it. */
const vocabularyOf = (repo: Repo, workspaceId: string, resolver: QueryResolver): QueryVocabulary => {
  const definitions = repo.propertyDefinitions
  const uis = repo.facetRuntime?.read(propertyEditorOverridesFacet) ?? new Map()
  return {
    types: [...repo.types.values()].flatMap(contribution => {
      const type = resolver.typeById(contribution.id)
      return type ? [{...type, plumbing: contribution.hideFromCompletion === true}] : []
    }),
    propertyNames: [...definitions?.definitionsByName.keys() ?? []]
      .filter(name => name !== queryProp.name && isPropertyPickerName(name, repo.propertySchemas, uis, definitions)),
    fieldNames: [...repo.facetRuntime?.read(queryableFieldsFacet, workspaceId)?.keys() ?? []],
  }
}

/** Where the query text of the fence at `pos` starts: the line after the opening fence. */
const fenceContentStart = (state: EditorState, pos: number): number | undefined => {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FencedCode') return state.doc.lineAt(node.from).to + 1
  }
  return undefined
}

const queryCompletionSource = (repo: Repo, block: Block): CompletionSource => context => {
  const {state, pos} = context
  if (!state.selection.main.empty || !isInsideLiteralMarkdown(state, pos)) return null
  const start = fenceContentStart(state, pos)
  const workspaceId = block.peek()?.workspaceId
  // `start > pos` is the opening fence line; defence in depth, since a reversed slice reads as no term anyway.
  if (start === undefined || start > pos || !workspaceId) return null
  const line = state.doc.lineAt(pos)
  const trigger = queryTriggerAt(state.doc.sliceString(start, pos), state.doc.sliceString(pos, line.to))
  if (!trigger) return null
  const resolver = queryResolver(repo, workspaceId, repo.propertyDefinitions, repo.types, new Map())
  const completions = queryCompletions(trigger, vocabularyOf(repo, workspaceId, resolver), resolver)
  if (completions.length === 0) return null
  return {
    from: start + trigger.from,
    to: start + trigger.to,
    // Ranked and matched here; CodeMirror's filter would match the label against `#…`.
    filter: false,
    options: completions.map(completion => ({
      label: completion.label,
      detail: completion.detail,
      type: trigger.kind === 'type' ? 'class' : 'property',
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
