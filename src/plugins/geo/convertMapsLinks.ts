/** Turns the Google Maps links in a block into `[[Place]]` wikilinks,
 *  creating (or reusing) the Place each one points at — the same Place
 *  and link the `@` autocomplete would produce, so the block lands on
 *  maps through its body reference. */

import type { EditorView } from '@codemirror/view'
import type { Repo } from '@/data/repo'
import { replaceBlockText } from './blockTextReplace'
import type { PlaceCandidate } from './createOrFindPlace'
import { findGoogleMapsLinks } from './googleMapsLink'
import { createOrFindPlaceInteractive } from './placeNameCollision'
import { MapsLinkError } from './resolveMapsLink'

export interface MapsLinkConversion {
  converted: number
  /** User-facing reasons, one per link left unconverted. */
  failures: string[]
}

const failureMessage = (url: string, err: unknown): string => {
  if (err instanceof MapsLinkError) return err.message
  console.warn('[geo] maps link conversion failed', url, err)
  return `Couldn't convert ${url}`
}

/** `view`, when the block is being edited: the text is read from and
 *  written to the live editor, which leads the stored row. */
export const convertMapsLinksInBlock = async (
  {repo, blockId, view}: {repo: Repo; blockId: string; view?: EditorView},
  resolveLink: (url: string) => Promise<PlaceCandidate>,
): Promise<MapsLinkConversion> => {
  const data = await repo.load(blockId)
  if (!data) return {converted: 0, failures: []}
  const text = view ? view.state.doc.toString() : data.content

  const result: MapsLinkConversion = {converted: 0, failures: []}
  // One at a time: a name collision opens a toast that waits on the user.
  for (const link of findGoogleMapsLinks(text)) {
    try {
      const place = await createOrFindPlaceInteractive(repo, data.workspaceId, await resolveLink(link.url))
      if (!place) continue
      const replaced = await replaceBlockText({
        repo,
        blockId,
        view,
        span: link,
        text: text.slice(link.from, link.to),
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
