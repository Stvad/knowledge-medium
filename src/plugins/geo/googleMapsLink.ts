/** Google Maps share links → what they say about a place. Pure parsing;
 *  resolving the result to a Place is `resolveMapsLink.ts`.
 *
 *  A full place URL carries two coordinate pairs that mean different
 *  things: `!3d<lat>!4d<lng>` in the `data=` blob is the place itself,
 *  while `/@<lat>,<lng>,<zoom>z` is only where the map was centred when
 *  the link was copied — often the same spot, but not after the user
 *  panned away. They are kept apart (`coords` vs `viewport`) so nothing
 *  pins a place at the map centre by mistake.
 *
 *  Short links (`maps.app.goo.gl/…`) carry nothing until expanded, which
 *  a browser cannot do (the redirect has no CORS headers). */

import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'

export interface LatLng {
  lat: number
  lng: number
}

export type ParsedMapsLink =
  | {kind: 'short'}
  | {
      kind: 'full'
      /** Place name or search text — what Google Maps would search for. */
      query?: string
      placeId?: string
      /** Google's numeric feature id, decimal — the `cid` in the
       *  `googleMapsUri` the Places API returns for the same place. */
      cid?: string
      /** The place's own position. */
      coords?: LatLng
      /** The map centre at share time — a search bias only, never a
       *  place's position. */
      viewport?: LatLng
    }

export interface MapsLinkMatch {
  /** Span to replace — includes a markdown-link or autolink wrapper. */
  from: number
  to: number
  url: string
}

const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/

const isShortLinkUrl = (u: URL): boolean =>
  u.hostname === 'maps.app.goo.gl'
  || (u.hostname === 'goo.gl' && u.pathname.startsWith('/maps/'))

const isFullMapsUrl = (u: URL): boolean =>
  GOOGLE_HOST.test(u.hostname)
  && (u.hostname.startsWith('maps.') || u.pathname === '/maps' || u.pathname.startsWith('/maps/'))

const COORD_PAIR = /^(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/

/** The one range check, whichever syntax the pair came in. */
const toLatLng = (lat: number, lng: number): LatLng | undefined =>
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? {lat, lng} : undefined

const parseCoordPair = (text: string): LatLng | undefined => {
  const m = COORD_PAIR.exec(text.trim())
  return m ? toLatLng(Number(m[1]), Number(m[2])) : undefined
}

const PLACE_COORDS = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
const FEATURE_ID = /^0x[0-9a-f]+:(0x[0-9a-f]+)$/i
const DATA_FEATURE_ID = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i
const PLACE_ID_PREFIX = 'place_id:'

/** `0x<cell>:0x<cid>` → the cid, in decimal. */
const cidFromFeatureId = (featureId: string): string | undefined => {
  const m = FEATURE_ID.exec(featureId)
  return m ? BigInt(m[1]).toString() : undefined
}

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '))
  } catch {
    return segment
  }
}

type FullLink = Extract<ParsedMapsLink, {kind: 'full'}>

/** Folds a name-or-coords-or-place-id text (a `/place/<…>` segment, a `q`
 *  parameter) into the result. The first source to set a field wins. */
const readPlaceText = (out: FullLink, raw: string | null | undefined): void => {
  const text = raw?.trim()
  if (!text) return
  if (text.startsWith(PLACE_ID_PREFIX)) {
    out.placeId ??= text.slice(PLACE_ID_PREFIX.length)
    return
  }
  const coords = parseCoordPair(text)
  if (coords) out.coords ??= coords
  else out.query ??= text
}

export const parseGoogleMapsUrl = (url: string): ParsedMapsLink | null => {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (isShortLinkUrl(u)) return {kind: 'short'}
  if (!isFullMapsUrl(u)) return null

  const out: FullLink = {kind: 'full'}
  const segments = u.pathname.split('/')

  const nameAt = segments.findIndex(s => s === 'place' || s === 'search') + 1
  const nameSegment = nameAt > 0 ? segments[nameAt] : undefined
  if (nameSegment && !nameSegment.startsWith('@') && !nameSegment.startsWith('data=')) {
    readPlaceText(out, decodeSegment(nameSegment))
  }

  const dataCoords = PLACE_COORDS.exec(u.pathname)
  const placeCoords = dataCoords ? toLatLng(Number(dataCoords[1]), Number(dataCoords[2])) : undefined
  if (placeCoords) out.coords ??= placeCoords

  const viewportSegment = segments.find(s => s.startsWith('@'))
  if (viewportSegment) {
    const [lat, lng] = viewportSegment.slice(1).split(',')
    const viewport = parseCoordPair(`${lat},${lng}`)
    if (viewport) out.viewport = viewport
  }

  const dataFeatureId = DATA_FEATURE_ID.exec(u.pathname)
  const featureId = dataFeatureId?.[1] ?? u.searchParams.get('ftid')
  const cid = (featureId ? cidFromFeatureId(featureId) : undefined) ?? u.searchParams.get('cid') ?? undefined
  if (cid) out.cid = cid

  readPlaceText(out, u.searchParams.get('q'))
  readPlaceText(out, u.searchParams.get('query'))
  const queryPlaceId = u.searchParams.get('query_place_id')
  if (queryPlaceId) out.placeId ??= queryPlaceId

  return out
}

/** Parent nodes whose span IS the link — replacing the URL means
 *  replacing the whole `[label](url)` / `<url>`. */
const LINK_WRAPPERS: ReadonlySet<string> = new Set(['Link', 'Autolink'])
/** A URL here isn't a link to the place (an image source, a reference
 *  definition), so it isn't converted. */
const NOT_A_LINK: ReadonlySet<string> = new Set(['Image', 'LinkReference'])

/** A bare URL in a link's LABEL is a URL node too; the destination is the
 *  one right after the `(` mark. */
const isLinkDestination = (text: string, url: SyntaxNode): boolean => {
  const mark = url.prevSibling
  return mark?.name === 'LinkMark' && text.slice(mark.from, mark.to) === '('
}

/** A `[label](…)` destination's value — the node text keeps the `<…>`
 *  wrapper and backslash escapes markdown allows there. */
const destinationValue = (raw: string): string =>
  (raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw)
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')

/** Found by the editor's markdown parser rather than a regex, so links
 *  in code stay literal and URL boundaries follow GFM (trailing
 *  punctuation dropped, balanced parentheses kept). */
export const findGoogleMapsLinks = (text: string): MapsLinkMatch[] => {
  const out: MapsLinkMatch[] = []
  markdownLanguage.parser.parse(text).iterate({
    enter: node => {
      if (node.name !== 'URL') return
      const parent = node.node.parent
      if (parent && NOT_A_LINK.has(parent.name)) return
      if (parent?.name === 'Link' && !isLinkDestination(text, node.node)) return
      const raw = text.slice(node.from, node.to)
      const url = parent?.name === 'Link' ? destinationValue(raw) : raw
      if (parseGoogleMapsUrl(url) === null) return
      const span = parent && LINK_WRAPPERS.has(parent.name) ? parent : node
      out.push({from: span.from, to: span.to, url})
    },
  })
  return out
}
