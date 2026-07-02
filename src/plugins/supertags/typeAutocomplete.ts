/** CodeMirror CompletionSource for the `#` type-tag trigger (Tana-style
 *  supertags).
 *
 *  Trigger shape mirrors the geo plugin's `@` matcher: `#<query>` with
 *  no word character before the `#` (so URLs like `example.com#anchor`
 *  and `a#b` don't fire), no `[`/`]` in the query (the wikilink
 *  autocomplete owns `[[…`), and single spaces allowed inside the query
 *  (type labels like "Meeting Note" span words). A query starting with
 *  a space never matches, which keeps markdown headings (`# Title`)
 *  out of the trigger.
 *
 *  On select the trigger text (`#query`) is deleted from the doc
 *  immediately — the tag lives in the block's `types` property and is
 *  rendered as a trailing chip by `TypeChipsDecorator`, not as text —
 *  and the (async) type write is fired through `pickType`.
 *
 *  The source is pure w.r.t. data access: it takes already-resolved
 *  candidates and a `pickType` callback. Wiring to the repo (the live
 *  `typesFacet` registry, `addType`, `createTypeBlock`) happens in the
 *  plugin's CodeMirror extension. */

import { EditorSelection } from '@codemirror/state'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { TypeContribution } from '@/data/api'
import {
  BLOCK_TYPE_TYPE,
  EXTENSION_TYPE,
  PAGE_TYPE,
  PANEL_STACK_TYPE,
  PANEL_TYPE,
  PROPERTIES_PAGE_TYPE,
  PROPERTY_SCHEMA_TYPE,
  RECENTS_PAGE_TYPE,
  TYPES_PAGE_TYPE,
  USER_TYPE,
} from '@/data/blockTypes'

/** Kernel types that are structural plumbing rather than user-facing
 *  tags: offering `#page` / `#panel` in the dropdown invites corrupting
 *  UI-state blocks, and chip-rendering them would stamp `#Page` on
 *  every page title. Plugin-contributed and user-defined types are all
 *  visible. Shared by the autocomplete and the chip decorator so the
 *  two surfaces stay consistent. */
export const HIDDEN_TYPE_IDS: ReadonlySet<string> = new Set([
  BLOCK_TYPE_TYPE,
  EXTENSION_TYPE,
  PAGE_TYPE,
  PANEL_STACK_TYPE,
  PANEL_TYPE,
  PROPERTIES_PAGE_TYPE,
  PROPERTY_SCHEMA_TYPE,
  RECENTS_PAGE_TYPE,
  TYPES_PAGE_TYPE,
  USER_TYPE,
])

/** Which of a block's types display as trailing tag chips: everything
 *  except structural kernel types and types whose contribution opts
 *  out via `hideTag` (`block-type:hide-tag` on user-defined types).
 *  Display-only policy — `buildTypeTagCandidates` deliberately does
 *  NOT consult `hideTag`, so a chip-hidden type stays taggable. */
export const visibleTagTypeIds = (
  typeIds: readonly string[],
  registry: ReadonlyMap<string, TypeContribution>,
): readonly string[] =>
  typeIds.filter(typeId =>
    !HIDDEN_TYPE_IDS.has(typeId) && registry.get(typeId)?.hideTag !== true)

export interface TypeTagCandidate {
  kind: 'existing' | 'create'
  /** For `existing`, the registered type id (what `addType` takes).
   *  For `create`, a `create:<label>` marker — the real id is the
   *  type-definition block id minted at pick time. */
  id: string
  /** Display label: the type's label for `existing`, the to-be-created
   *  label (trimmed query) for `create`. */
  label: string
  detail?: string
}

interface TriggerMatch {
  /** Position in the line where the `#` sits. The trigger span
   *  (`#query`) is deleted from here on pick. */
  from: number
  /** The text typed after `#`, possibly empty. */
  query: string
}

/** Same caps as the geo `@` matcher, same rationale: labels span words
 *  ("Meeting Note"), but without the caps every sentence containing a
 *  bare `#word` would re-open the dropdown on each keystroke until end
 *  of line. */
const MAX_QUERY_LEN = 50
const MAX_QUERY_WORDS = 6

/** Dropdown length cap. Typing narrows the list, so truncation only
 *  ever hides types the query hasn't disambiguated yet. */
const RESULT_CAP = 12

const isInsideUnclosedWikilink = (text: string, beforePos: number): boolean => {
  let opens = 0
  let closes = 0
  for (let i = 0; i < beforePos - 1; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      opens += 1
      i += 1
    } else if (text[i] === ']' && text[i + 1] === ']') {
      closes += 1
      i += 1
    }
  }
  return opens > closes
}

/** Pure trigger-detection helper. Exported for direct testing — the
 *  CompletionSource glue just adapts to CodeMirror's call shape. */
export const matchHashTrigger = (text: string, pos: number): TriggerMatch | null => {
  // Walk backward from the cursor to find the most recent `#`. Single
  // spaces are part of the query; wikilink brackets, non-space
  // whitespace, a double space, or an over-long scan interrupt the
  // trigger sequence.
  let i = pos
  while (i > 0) {
    const c = text[i - 1]
    if (c === '#') break
    if (c === ' ') {
      if (i >= 2 && text[i - 2] === ' ') return null
    } else if (/\s/.test(c)) {
      return null
    }
    if (c === '[' || c === ']') return null
    if (pos - i >= MAX_QUERY_LEN) return null
    i -= 1
  }
  if (i === 0 || text[i - 1] !== '#') return null

  const query = text.slice(i, pos)
  // `# Title` is a markdown heading, not a half-typed type query.
  if (query.startsWith(' ')) return null
  if (query.split(' ').filter(w => w.length > 0).length > MAX_QUERY_WORDS) return null

  const hashPos = i - 1
  // Word char immediately before `#` → URL anchor / mid-word hash; skip.
  if (hashPos > 0 && /\w/.test(text[hashPos - 1])) return null
  // Stacked hashes (`##foo`) are heading syntax territory, not a tag.
  if (hashPos > 0 && text[hashPos - 1] === '#') return null
  // `#` directly preceded by `[` → inside a half-typed `[[#foo`; skip.
  if (hashPos > 0 && text[hashPos - 1] === '[') return null
  // `#` lives inside an unclosed `[[...` somewhere earlier on the
  // line → the wikilink autocomplete owns this input.
  if (isInsideUnclosedWikilink(text, hashPos)) return null

  return {from: hashPos, query}
}

const labelOf = (type: TypeContribution): string => type.label ?? type.id

/** Pure candidate builder over a registry snapshot. Exported for
 *  direct testing; the plugin extension feeds it `repo.types` and the
 *  block's current `types` property.
 *
 *  The `create` sentinel appears for any non-empty query that isn't an
 *  exact label/id match against the FULL registry (hidden and
 *  already-applied types included) — offering to create a second
 *  "Task" because the first is hidden from the dropdown would mint
 *  duplicate labels. */
export const buildTypeTagCandidates = (args: {
  registry: ReadonlyMap<string, TypeContribution>
  currentTypeIds: readonly string[]
  query: string
}): TypeTagCandidate[] => {
  const trimmed = args.query.trim()
  const q = trimmed.toLowerCase()
  const current = new Set(args.currentTypeIds)
  const all = Array.from(args.registry.values())

  const matches = all.filter(type =>
    !HIDDEN_TYPE_IDS.has(type.id) &&
    !current.has(type.id) &&
    (q === '' ||
      labelOf(type).toLowerCase().includes(q) ||
      type.id.toLowerCase().includes(q)))

  const rank = (type: TypeContribution): number =>
    labelOf(type).toLowerCase().startsWith(q) ? 0 : 1
  matches.sort((a, b) =>
    rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b)))

  const existing = matches.slice(0, RESULT_CAP).map((type): TypeTagCandidate => ({
    kind: 'existing',
    id: type.id,
    label: labelOf(type),
    detail: type.description,
  }))

  const exactExists = q !== '' && all.some(type =>
    labelOf(type).toLowerCase() === q || type.id.toLowerCase() === q)
  if (trimmed === '' || exactExists) return existing

  return [...existing, {
    kind: 'create',
    id: `create:${trimmed}`,
    label: trimmed,
    detail: 'Create new type',
  }]
}

export interface TypeTagAutocompleteOptions {
  /** Candidates for the current query, in display order. */
  getCandidates: (query: string) => TypeTagCandidate[] | Promise<TypeTagCandidate[]>
  /** Called when the user picks a candidate, after the `#query`
   *  trigger text has been deleted from the doc. Async — the tag write
   *  (and for `create`, the type-definition materialization) settles
   *  in the background while the user keeps typing. */
  pickType: (candidate: TypeTagCandidate) => Promise<void>
}

const candidateToOption = (
  candidate: TypeTagCandidate,
  options: TypeTagAutocompleteOptions,
): Completion => ({
  label: candidate.kind === 'create' ? `Create type "${candidate.label}"` : candidate.label,
  detail: candidate.detail,
  type: candidate.kind === 'create' ? 'keyword' : 'class',
  apply: (view, _completion, applyFrom, applyTo) => {
    // Delete the trigger text synchronously while the view is
    // guaranteed alive; the tag itself lands on the block's `types`
    // property, not in the content. No text survives to need a
    // persistence fallback if the pick's async half fails.
    view.dispatch({
      changes: {from: applyFrom, to: applyTo, insert: ''},
      selection: EditorSelection.cursor(applyFrom),
    })
    options.pickType(candidate).catch((err: unknown) => {
      console.warn('[supertags] failed to apply type', candidate.id, err)
    })
  },
})

export const typeTagCompletionSource = (
  options: TypeTagAutocompleteOptions,
): CompletionSource => {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const {state, pos, explicit} = context
    const line = state.doc.lineAt(pos)
    const match = matchHashTrigger(line.text, pos - line.from)
    if (!match) return null

    const candidates = await options.getCandidates(match.query)
    if (candidates.length === 0 && !explicit) return null

    return {
      from: line.from + match.from,
      to: pos,
      // Source-side filtering: buildTypeTagCandidates already matched
      // the query, and CodeMirror's fuzzy filter would drop the
      // `Create type "…"` sentinel whose label doesn't contain the
      // typed text in filterable form.
      filter: false,
      options: candidates.map(c => candidateToOption(c, options)),
    }
  }
}
