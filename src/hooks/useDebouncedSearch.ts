import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebouncedValue } from './useDebouncedValue.js'

export interface DebouncedSearchOptions<T> {
  /** Raw input value; trimmed and debounced internally. */
  query: string
  /** Quiet window (ms) a non-empty query must hold before a search fires. */
  delayMs: number
  /** When false, no search runs (e.g. before a workspace is known). The
   *  current `results` are left as-is — call `reset()` to clear them. */
  enabled?: boolean
  /** Runs the actual search for the settled query. Held in a ref, so a fresh
   *  closure on every render does NOT re-run or loop the effect — pass an
   *  inline closure freely; it always sees the latest captured values. */
  search: (query: string) => Promise<T[]>
  /** Called with fresh results when a search resolves — e.g. to reset the
   *  active option to 0. Also held in a ref (non-reactive). */
  onResults?: (results: T[]) => void
  /** Extra values that should re-run the search when they change while the
   *  query is settled (e.g. the exclude-set, the workspace id). Treated as
   *  effect dependencies, so pass referentially-stable values (memoize
   *  objects/sets). */
  revalidateOn?: readonly unknown[]
}

/** Debounced, self-cancelling async search feeding an autocomplete list.
 *
 *  Pairs with `useAutocompleteListbox` (which owns the active-index/keyboard
 *  interaction) — this hook owns only the query→results half: trim, debounce,
 *  fire once the debounce settles, and cancel any in-flight request the moment
 *  the input changes. The cancellation is what keeps a late result for the
 *  previous (or cleared) text from repopulating `results` and letting a commit
 *  add a stale entry; centralizing it here means each consumer can't re-break
 *  that race independently. */
export function useDebouncedSearch<T>({
  query,
  delayMs,
  enabled = true,
  search,
  onResults,
  revalidateOn = [],
}: DebouncedSearchOptions<T>): { results: T[]; resultsQuery: string; reset: () => void } {
  const [results, setResults] = useState<T[]>([])
  // The (trimmed) query the current `results` were fetched for. During the
  // debounce window this lags the live input, so a consumer's submit path can
  // compare it against the current trimmed text to avoid committing a result
  // that belongs to the previous query.
  const [resultsQuery, setResultsQuery] = useState('')
  const trimmed = query.trim()
  const debounced = useDebouncedValue(trimmed, delayMs)

  // Latest-ref so the callbacks are non-reactive: correctness must not depend
  // on the caller (or the React Compiler) memoizing them. A fresh `search`
  // closure each render would otherwise re-run the effect, and since every
  // resolved search sets a new `results` array that would loop forever.
  const searchRef = useRef(search)
  const onResultsRef = useRef(onResults)
  useEffect(() => {
    searchRef.current = search
    onResultsRef.current = onResults
  })

  useEffect(() => {
    // Only search once the debounce has settled (`trimmed === debounced`);
    // `trimmed` stays in the deps so every keystroke re-runs the effect and
    // its cleanup cancels any in-flight search immediately.
    if (!enabled || !debounced || trimmed !== debounced) return
    let cancelled = false
    void searchRef.current(debounced).then(next => {
      if (cancelled) return
      setResults(next)
      setResultsQuery(debounced)
      onResultsRef.current?.(next)
    })
    return () => {
      cancelled = true
    }
    // search/onResults are intentionally read through refs (non-reactive);
    // revalidateOn carries the caller's real re-search triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debounced, trimmed, ...revalidateOn])

  const reset = useCallback(() => {
    setResults([])
    setResultsQuery('')
  }, [])

  return { results, resultsQuery, reset }
}
