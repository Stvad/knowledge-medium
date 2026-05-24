/** CodeMirror CompletionSource for the `@` place trigger.
 *
 *  Trigger shape: `@<query>` at start of line or after whitespace, with
 *  no `[` in the query (so we don't fire inside `[[`) and no preceding
 *  word character (so we don't fire mid-email `a@b`). The query may be
 *  empty — that's the moment to surface the "Use current location"
 *  sentinel (Phase F).
 *
 *  On select: the caller-supplied `resolvePlace` returns a
 *  `PlaceResolveResult`. Two kinds:
 *    - `{kind: 'insert', name}` → we replace the trigger span with
 *      `[[<name>]]` (the references plugin picks up the wikilink).
 *    - `{kind: 'handled'}` → the resolver dispatched its own change /
 *      opened a follow-up picker; the source stays out of the way.
 *  Returning `null` cancels the insertion (user dismissed a sub-prompt).
 *
 *  Follow-up pickers (Phase F current-location list) re-enter the
 *  source via `consumePendingCandidates`: a one-shot stash of
 *  candidates + span that the caller pushes from a candidate's apply
 *  handler, then triggers `startCompletion(view)` so CM re-opens the
 *  dropdown with the new list — no second UI to maintain.
 *
 *  The source is *pure* w.r.t. data access — it takes already-resolved
 *  candidates and a `resolvePlace` callback. Wiring to the repo, the
 *  Google client, and `createOrFindPlace` happens in the geo plugin's
 *  CodeMirror extension. */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'

export type PlaceCandidateSource =
  | 'local'
  | 'google'
  | 'sentinel:current-location'
  | 'drop-pin'
  | 'create-named'

export interface PlaceAutocompleteCandidate {
  /** Stable id used for de-dup across sources and for picking. For local
   *  candidates, the block id; for Google, the placeId; for sentinels, a
   *  fixed string; for picker-stage candidates, includes the coords. */
  id: string
  source: PlaceCandidateSource
  /** Display label for the dropdown row. */
  label: string
  /** Optional secondary text (address, distance, etc.). */
  detail?: string
  /** Final wikilink text to insert. For Google candidates this is set
   *  during pick (after getDetails resolves the canonical name); for
   *  local matches it's the existing block's name. */
  insertText: string
  /** Coords stashed on picker-stage candidates (drop-pin, create-named)
   *  so resolution can create the Place without re-fetching geolocation. */
  coords?: {lat: number, lng: number}
}

export type PlaceResolveResult =
  | {kind: 'insert', name: string}
  /** Resolver handled the change itself (e.g. opened a follow-up
   *  picker). Source skips the default `[[...]]` insertion. */
  | {kind: 'handled'}
  | null

export interface PlaceResolveContext {
  view: EditorView
  /** Trigger span in the doc — same range CM passes to the apply
   *  callback. Resolvers that re-open the dropdown should re-use this
   *  span for the follow-up so the user's `@here` text stays in place. */
  from: number
  to: number
}

export interface PlaceAutocompleteOptions {
  /** Callback to fetch candidates for the current query. Returns a list
   *  in display order. Implementations bundle: local alias scan,
   *  optionally Google autocomplete (gated by query length and API key),
   *  and the current-location sentinel when appropriate. */
  getCandidates: (query: string) => Promise<PlaceAutocompleteCandidate[]>
  /** Called when the user selects a candidate. Returns either an insert
   *  spec, `{kind:'handled'}` if the resolver took ownership of the
   *  change, or `null` to cancel. */
  resolvePlace: (
    candidate: PlaceAutocompleteCandidate,
    ctx: PlaceResolveContext,
  ) => Promise<PlaceResolveResult>
  /** Optional one-shot stash drained at the top of every source call.
   *  Used by follow-up pickers: a candidate's resolver stashes the next
   *  round of candidates (with their target span) and calls
   *  `startCompletion(view)`. The next invocation returns them
   *  verbatim, bypassing `@` trigger detection. */
  consumePendingCandidates?: () => {
    span: {from: number, to: number}
    candidates: PlaceAutocompleteCandidate[]
  } | null
}

interface TriggerMatch {
  /** Character position in the doc where the `@` itself sits. The
   *  inserted text replaces from here (so the `@` is removed). */
  from: number
  /** The text typed after `@`, possibly empty. */
  query: string
}

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
export const matchAtTrigger = (text: string, pos: number): TriggerMatch | null => {
  // Walk backward from the cursor to find the most recent `@`. Bail on
  // whitespace or wikilink brackets between the cursor and the `@` —
  // those interrupt the trigger sequence.
  let i = pos
  while (i > 0) {
    const c = text[i - 1]
    if (c === '@') break
    if (/\s/.test(c)) return null
    if (c === '[' || c === ']') return null
    i -= 1
  }
  if (i === 0 || text[i - 1] !== '@') return null

  const atPos = i - 1
  // Word char immediately before `@` → email-like (`a@b`); skip.
  if (atPos > 0 && /\w/.test(text[atPos - 1])) return null
  // `@` directly preceded by `[` → inside a half-typed `[[@foo`; skip.
  if (atPos > 0 && text[atPos - 1] === '[') return null
  // `@` lives inside an unclosed `[[...` somewhere earlier on the
  // line → the wikilink autocomplete owns this input.
  if (isInsideUnclosedWikilink(text, atPos)) return null

  return {from: atPos, query: text.slice(i, pos)}
}

const candidateToOption = (
  candidate: PlaceAutocompleteCandidate,
  resolve: PlaceAutocompleteOptions['resolvePlace'],
): Completion => ({
  label: candidate.label,
  detail: candidate.detail,
  type: candidate.source === 'sentinel:current-location' ? 'keyword' : 'class',
  apply: (view, _completion, applyFrom, applyTo) => {
    // Fire-and-forget — the dropdown closes immediately. Errors
    // surface via the resolvePlace impl (toast, console).
    void (async () => {
      const resolved = await resolve(candidate, {view, from: applyFrom, to: applyTo})
      if (!resolved) return
      if (resolved.kind === 'handled') return
      const insert = `[[${resolved.name}]]`
      view.dispatch({
        changes: {from: applyFrom, to: applyTo, insert},
        selection: EditorSelection.cursor(applyFrom + insert.length),
      })
    })()
  },
})

export const placeCompletionSource = (
  options: PlaceAutocompleteOptions,
): CompletionSource => {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const pending = options.consumePendingCandidates?.()
    if (pending) {
      return {
        from: pending.span.from,
        to: pending.span.to,
        filter: false,
        options: pending.candidates.map(c => candidateToOption(c, options.resolvePlace)),
      }
    }

    const {state, pos, explicit} = context
    const line = state.doc.lineAt(pos)
    const lineText = line.text
    const inLinePos = pos - line.from

    const match = matchAtTrigger(lineText, inLinePos)
    if (!match) return null
    // Don't open on every keystroke until the user has typed `@` — the
    // matcher already enforces that. We do show on an empty query
    // (matched immediately after `@`) so the sentinel surfaces.

    const candidates = await options.getCandidates(match.query)
    if (candidates.length === 0 && !explicit) return null

    const from = line.from + match.from
    return {
      from,
      to: pos,
      // Source-side filtering: getCandidates already filtered (local
      // alias LIKE + Google text rank). CodeMirror's default fuzzy
      // filter would hide e.g. a "Use current location" sentinel whose
      // label doesn't contain the typed text.
      filter: false,
      options: candidates.map(c => candidateToOption(c, options.resolvePlace)),
    }
  }
}
