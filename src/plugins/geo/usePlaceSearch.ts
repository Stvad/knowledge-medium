/** Shared place-search hook used by both the `@` autocomplete and the
 *  `location` property editor. Combines local-alias scan (Place blocks
 *  in the active workspace) with Google Places autocomplete, gated by
 *  the API key and a minimum query length.
 *
 *  The hook owns a session token that rotates after each successful
 *  Google `getDetails` call — keeps the billing session bounded to a
 *  single picker open. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Repo } from '@/data/repo'
import { typesProp } from '@/data/properties'
import { aliasesProp } from '@/data/internals/coreProperties'
import { PLACE_TYPE } from './blockTypes'
import {
  GooglePlacesError,
  createGooglePlacesClient,
  newSessionToken,
  resolveApiKey,
  type AutocompleteSuggestion,
  type GooglePlacesClient,
} from './googlePlacesClient'

const GOOGLE_MIN_QUERY_LEN = 2
const LOCAL_CAP = 8
const GOOGLE_CAP = 6
const DEBOUNCE_MS = 250

export type PlaceSearchSource = 'local' | 'google'

export interface PlaceSearchResult {
  id: string
  source: PlaceSearchSource
  label: string
  detail?: string
}

export interface UsePlaceSearchOptions {
  /** When supplied, ranks Google results closer to these coords first. */
  bias?: {lat: number; lng: number; radiusM?: number}
}

interface PlaceSearchState {
  results: PlaceSearchResult[]
  loading: boolean
  error: string | null
}

export interface PlaceSearchHandle extends PlaceSearchState {
  search: (query: string) => void
  /** Returns the Google client for follow-up `getDetails` /
   *  `searchNearby` calls; null when no API key. */
  client: GooglePlacesClient | null
  /** Current session token — pass to `getDetails` so the autocomplete
   *  and details calls bill as one. */
  sessionToken: string
  rotateSession: () => void
}

const aliasesOf = (block: { properties: Record<string, unknown> }): readonly string[] => {
  const raw = block.properties[aliasesProp.name]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

const isPlace = (block: { properties: Record<string, unknown> }): boolean => {
  const raw = block.properties[typesProp.name]
  return Array.isArray(raw) && raw.includes(PLACE_TYPE)
}

const displayLabel = (aliases: readonly string[], fallback: string): string =>
  aliases.find(a => !a.startsWith('place:') && !a.startsWith('geo:')) ?? fallback

const searchLocal = async (
  repo: Repo,
  workspaceId: string,
  query: string,
): Promise<PlaceSearchResult[]> => {
  const blocks = await repo.query.byType({workspaceId, type: PLACE_TYPE}).load()
  const trimmed = query.trim().toLowerCase()
  const out: PlaceSearchResult[] = []
  for (const block of blocks) {
    if (!isPlace(block)) continue
    const aliases = aliasesOf(block)
    const label = displayLabel(aliases, block.content)
    if (trimmed.length > 0) {
      const haystack = [label, block.content, ...aliases]
      if (!haystack.some(h => h.toLowerCase().includes(trimmed))) continue
    }
    out.push({
      id: block.id,
      source: 'local',
      label,
      detail: block.content !== label ? block.content : undefined,
    })
    if (out.length >= LOCAL_CAP) break
  }
  return out
}

const toGoogleResults = (suggestions: AutocompleteSuggestion[]): PlaceSearchResult[] =>
  suggestions.slice(0, GOOGLE_CAP).map(s => ({
    id: `google:${s.placeId}`,
    source: 'google' as const,
    label: s.primary,
    detail: s.secondary,
  }))

export const usePlaceSearch = (
  repo: Repo,
  options: UsePlaceSearchOptions = {},
): PlaceSearchHandle => {
  const [client] = useState<GooglePlacesClient | null>(() => {
    const apiKey = resolveApiKey()
    return apiKey ? createGooglePlacesClient({apiKey}) : null
  })
  const [sessionToken, setSessionToken] = useState<string>(() => newSessionToken())
  const [state, setState] = useState<PlaceSearchState>({results: [], loading: false, error: null})
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestQuery = useRef<string>('')

  useEffect(() => () => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current)
  }, [])

  const run = useCallback(async (query: string) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) {
      setState({results: [], loading: false, error: null})
      return
    }
    setState(s => ({...s, loading: true, error: null}))
    const localClient = client
    try {
      const local = await searchLocal(repo, workspaceId, query)
      // Surface local results immediately for snappy feel even if
      // Google is slow / errors.
      if (latestQuery.current === query) {
        setState({results: local, loading: localClient !== null, error: null})
      }

      if (localClient && query.trim().length >= GOOGLE_MIN_QUERY_LEN) {
        try {
          const suggestions = await localClient.autocomplete(query, {
            sessionToken,
            bias: options.bias,
          })
          if (latestQuery.current !== query) return
          const seen = new Set(local.map(r => r.id))
          const google = toGoogleResults(suggestions).filter(r => !seen.has(r.id))
          setState({results: [...local, ...google], loading: false, error: null})
        } catch (err) {
          if (latestQuery.current !== query) return
          const msg = err instanceof GooglePlacesError
            ? `Google ${err.kind} (${err.status ?? '–'})`
            : 'Google search failed'
          setState({results: local, loading: false, error: msg})
        }
      } else {
        if (latestQuery.current === query) {
          setState({results: local, loading: false, error: null})
        }
      }
    } catch (err) {
      if (latestQuery.current === query) {
        setState({
          results: [],
          loading: false,
          error: err instanceof Error ? err.message : 'search failed',
        })
      }
    }
  }, [repo, sessionToken, options.bias, client])

  const search = useCallback((query: string) => {
    latestQuery.current = query
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => { void run(query) }, DEBOUNCE_MS)
  }, [run])

  const rotateSession = useCallback(() => {
    setSessionToken(newSessionToken())
  }, [])

  return {
    ...state,
    search,
    client,
    sessionToken,
    rotateSession,
  }
}
