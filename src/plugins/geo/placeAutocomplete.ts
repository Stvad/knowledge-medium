/** CodeMirror CompletionSource for the `@` place trigger.
 *
 *  Trigger shape: `@<query>` at start of line or after whitespace, with
 *  no `[` in the query (so we don't fire inside `[[`) and no preceding
 *  word character (so we don't fire mid-email `a@b`). The query may be
 *  empty — that's the moment to surface the "Use current location"
 *  sentinel (Phase F).
 *
 *  On select: the caller-supplied `resolvePlace` returns a final
 *  PlaceCandidate (existing local Place, Google POI hydrated via
 *  getDetails, current-location pick, etc.). We then write
 *  `[[<name>]]` at the trigger span — the references plugin picks up
 *  the wikilink and writes the back-reference. No place-specific inline
 *  syntax.
 *
 *  The source is *pure* w.r.t. data access — it takes already-resolved
 *  candidates and an `onPicked` callback. Wiring to the repo, the
 *  Google client, and `createOrFindPlace` happens in the geo plugin's
 *  CodeMirror extension. */

import { EditorSelection } from '@codemirror/state'
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'

export type PlaceCandidateSource = 'local' | 'google' | 'sentinel:current-location'

export interface PlaceAutocompleteCandidate {
  /** Stable id used for de-dup across sources and for picking. For local
   *  candidates, the block id; for Google, the placeId; for sentinels, a
   *  fixed string. */
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
}

export interface PlaceAutocompleteOptions {
  /** Callback to fetch candidates for the current query. Returns a list
   *  in display order. Implementations bundle: local alias scan,
   *  optionally Google autocomplete (gated by query length and API key),
   *  and the current-location sentinel when appropriate. */
  getCandidates: (query: string) => Promise<PlaceAutocompleteCandidate[]>
  /** Called when the user selects a candidate. The caller resolves the
   *  candidate to a final `{name}` (for Google candidates that means a
   *  getDetails + createOrFindPlace round-trip; for sentinels that means
   *  walking the geolocation flow). Returning `null` cancels the
   *  insertion (e.g. the user dismissed a sub-dialog). */
  resolvePlace: (candidate: PlaceAutocompleteCandidate) => Promise<{name: string} | null>
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

export const placeCompletionSource = (
  options: PlaceAutocompleteOptions,
): CompletionSource => {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
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
      options: candidates.map(candidate => ({
        label: candidate.label,
        detail: candidate.detail,
        type: candidate.source === 'sentinel:current-location' ? 'keyword' : 'class',
        apply: (view, _completion, applyFrom, applyTo) => {
          // Fire-and-forget — the dropdown closes immediately. Errors
          // surface via the resolvePlace impl (toast, console).
          void (async () => {
            const resolved = await options.resolvePlace(candidate)
            if (!resolved) return
            const insert = `[[${resolved.name}]]`
            view.dispatch({
              changes: {from: applyFrom, to: applyTo, insert},
              selection: EditorSelection.cursor(applyFrom + insert.length),
            })
          })()
        },
      })),
    }
  }
}
