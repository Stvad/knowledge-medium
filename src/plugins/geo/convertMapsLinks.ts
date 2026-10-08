/** Turns the Google Maps links in a block into `[[Place]]` wikilinks,
 *  creating (or reusing) the Place each one points at — the same Place
 *  and link the `@` autocomplete would produce, so the block lands on
 *  maps through its body reference. */

import type { EditorView } from '@codemirror/view'
import type { Repo } from '@/data/repo'
import { readBlockText, replaceBlockText, type Locate, type TextSpan } from './blockTextReplace'
import type { PlaceCandidate } from './createOrFindPlace'
import { findGoogleMapsLinks } from './googleMapsLink'
import { GooglePlacesError } from './googlePlacesClient'
import { createOrFindPlaceInteractive } from './placeNameCollision'
import { MapsLinkError } from './resolveMapsLink'

export interface MapsLinkConversion {
  converted: number
  /** User-facing reasons, one per link left unconverted. */
  failures: string[]
}

/** The occurrence of `linkText` the parser still reads as a link — the
 *  recorded one if it's there, else the first — never a copy in code. */
const locateLink = (linkText: string, near: TextSpan): Locate => doc => {
  const same = findGoogleMapsLinks(doc).filter(l => doc.slice(l.from, l.to) === linkText)
  return same.find(l => l.from === near.from) ?? same[0] ?? null
}

const failureMessage = (url: string, err: unknown): string => {
  if (err instanceof MapsLinkError) return err.message
  // Not degraded to the link's own data: that Place would never dedup with
  // the Google POI a retry finds, so the link waits for the retry instead.
  if (err instanceof GooglePlacesError) {
    return `Couldn't reach Google Places (${err.kind}) for ${url} — try again.`
  }
  console.warn('[geo] maps link conversion failed', url, err)
  return `Couldn't convert ${url}`
}

/** `view`, when the block is being edited: the text is read from and
 *  written to the live editor, which leads the stored row. */
export const convertMapsLinksInBlock = async (
  {repo, blockId, view}: {repo: Repo; blockId: string; view?: EditorView},
  resolveLink: (url: string) => Promise<PlaceCandidate>,
): Promise<MapsLinkConversion> => {
  const result: MapsLinkConversion = {converted: 0, failures: []}
  const data = await repo.load(blockId)
  const text = await readBlockText(repo, blockId, view)
  if (!data || text === null) return result

  // One at a time: a name collision opens a toast that waits on the user.
  for (const link of findGoogleMapsLinks(text)) {
    const locate = locateLink(text.slice(link.from, link.to), link)
    try {
      const candidate = await resolveLink(link.url)
      // The lookup takes a while; don't mint a Place for a link the user
      // has since removed. (A removal during a collision prompt is
      // accepted: the prompt's choice is itself a deliberate action.)
      const current = await readBlockText(repo, blockId, view)
      if (current === null || locate(current) === null) continue
      const place = await createOrFindPlaceInteractive(repo, data.workspaceId, candidate)
      if (!place) continue
      const replaced = await replaceBlockText({
        repo,
        blockId,
        view,
        locate,
        replacement: `[[${place.linkName}]]`,
        description: 'convert maps link to place',
      })
      if (replaced) result.converted++
    } catch (err) {
      result.failures.push(failureMessage(link.url, err))
    }
  }
  return result
}
