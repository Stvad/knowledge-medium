/** CodeMirror surface for the geo plugin: autocomplete theme + `@`
 *  completion source contributed via `EditorState.languageData`. The
 *  single central `autocompletion()` call (in
 *  `src/extensions/editorAutocomplete.ts`) walks language data and
 *  picks the source up. The session token, Google client, and resolver
 *  all live in a closure created per editor mount, so the billing
 *  session boundary still matches "one `@` press' worth of
 *  interactions". */

import type { CompletionSource } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/extensions/editor.js'
import { typesProp } from '@/data/properties'
import { aliasesProp } from '@/data/internals/coreProperties'
import { PLACE_TYPE } from './blockTypes'
import { placeCompletionSource, type PlaceAutocompleteCandidate } from './placeAutocomplete'
import {
  GooglePlacesError,
  createGooglePlacesClient,
  newSessionToken,
  resolveApiKey,
  type AutocompleteSuggestion,
  type GooglePlacesClient,
} from './googlePlacesClient'
import { createOrFindPlace, type PlaceCandidate } from './createOrFindPlace'
import { pickCurrentLocation } from './pickCurrentLocation'

const GOOGLE_MIN_QUERY_LEN = 2
const LOCAL_RESULT_CAP = 8
const GOOGLE_RESULT_CAP = 6

const placeAutocompleteTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete.tm-place-autocomplete': {
    zIndex: '1000',
    overflow: 'hidden',
    border: '1px solid hsl(var(--border))',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    padding: '0.25rem',
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  },
})

const aliasesOf = (block: { properties: Record<string, unknown> }): readonly string[] => {
  const raw = block.properties[aliasesProp.name]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

const isPlaceBlock = (block: { properties: Record<string, unknown> }): boolean => {
  const raw = block.properties[typesProp.name]
  return Array.isArray(raw) && raw.includes(PLACE_TYPE)
}

const buildPlaceCompletionSource = ({repo}: CodeMirrorExtensionContext): CompletionSource => {
  const apiKey = resolveApiKey()
  const googleClient: GooglePlacesClient | null = apiKey
    ? createGooglePlacesClient({apiKey})
    : null
  let sessionToken = newSessionToken()

  const localCandidates = async (query: string): Promise<PlaceAutocompleteCandidate[]> => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return []
    const placeBlocks = await repo.query.byType({workspaceId, type: PLACE_TYPE}).load()
    const trimmed = query.trim().toLowerCase()
    const candidates: PlaceAutocompleteCandidate[] = []
    for (const block of placeBlocks) {
      if (!isPlaceBlock(block)) continue
      const aliases = aliasesOf(block)
      const display = aliases.find(a => !a.startsWith('place:') && !a.startsWith('geo:')) ?? block.content
      if (trimmed.length > 0) {
        const haystack = [display, block.content, ...aliases]
        if (!haystack.some(h => h.toLowerCase().includes(trimmed))) continue
      }
      candidates.push({
        id: block.id,
        source: 'local',
        label: display,
        detail: block.content !== display ? block.content : undefined,
        insertText: display,
      })
      if (candidates.length >= LOCAL_RESULT_CAP) break
    }
    return candidates
  }

  const googleCandidates = async (query: string): Promise<PlaceAutocompleteCandidate[]> => {
    if (!googleClient) return []
    if (query.trim().length < GOOGLE_MIN_QUERY_LEN) return []
    let suggestions: AutocompleteSuggestion[]
    try {
      suggestions = await googleClient.autocomplete(query, {sessionToken})
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        console.warn('[geo] Google autocomplete failed', err)
        return []
      }
      throw err
    }
    return suggestions.slice(0, GOOGLE_RESULT_CAP).map((s): PlaceAutocompleteCandidate => ({
      id: `google:${s.placeId}`,
      source: 'google',
      label: s.primary,
      detail: s.secondary,
      insertText: s.primary,
    }))
  }

  const currentLocationSentinel = (query: string): PlaceAutocompleteCandidate[] => {
    const trimmed = query.trim().toLowerCase()
    if (trimmed.length > 0 && trimmed !== 'here' && trimmed !== 'current') return []
    return [{
      id: 'sentinel:current-location',
      source: 'sentinel:current-location',
      label: '📍 Use current location…',
      detail: 'Drop a pin or snap to a nearby place',
      insertText: '',
    }]
  }

  const getCandidates = async (query: string): Promise<PlaceAutocompleteCandidate[]> => {
    const [local, google] = await Promise.all([
      localCandidates(query),
      googleCandidates(query),
    ])
    const seenGoogleIds = new Set(
      local
        .map(c => c.id)
        .filter(id => id.startsWith('google:'))
        .map(id => id.replace('google:', '')),
    )
    return [
      ...currentLocationSentinel(query),
      ...local,
      ...google.filter(c => !seenGoogleIds.has(c.id.replace('google:', ''))),
    ]
  }

  const resolvePlace = async (
    candidate: PlaceAutocompleteCandidate,
  ): Promise<{name: string} | null> => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return null

    if (candidate.source === 'local') {
      return {name: candidate.insertText}
    }

    if (candidate.source === 'google') {
      if (!googleClient) return null
      const placeId = candidate.id.replace(/^google:/, '')
      try {
        const details = await googleClient.getDetails(placeId, {sessionToken})
        // Close the billing session by rotating the token.
        sessionToken = newSessionToken()
        const candidatePayload: PlaceCandidate = {
          name: details.name,
          lat: details.lat,
          lng: details.lng,
          address: details.address,
          googlePlaceId: details.placeId,
          googleMapsUrl: details.googleMapsUrl,
          website: details.website,
          phone: details.phone,
          categories: details.categories,
        }
        const placeBlock = await createOrFindPlace(repo, workspaceId, candidatePayload)
        const aliases = aliasesOf(placeBlock.peek() ?? {properties: {}})
        const display = aliases.find(a => !a.startsWith('place:') && !a.startsWith('geo:')) ?? details.name
        return {name: display}
      } catch (err) {
        console.warn('[geo] Google details / place creation failed', err)
        return null
      }
    }

    if (candidate.source === 'sentinel:current-location') {
      const result = await pickCurrentLocation(repo, workspaceId)
      if (!result) return null
      const aliases = aliasesOf(result.block.peek() ?? {properties: {}})
      const display = aliases.find(a => !a.startsWith('place:') && !a.startsWith('geo:'))
        ?? result.block.peek()?.content
        ?? 'Location'
      return {name: display}
    }

    return null
  }

  return placeCompletionSource({getCandidates, resolvePlace})
}

export const geoCodeMirrorExtensions: CodeMirrorExtensionContribution = (ctx) => {
  const placeSource = buildPlaceCompletionSource(ctx)
  return [
    placeAutocompleteTheme,
    EditorState.languageData.of(() => [{autocomplete: placeSource}]),
  ]
}
