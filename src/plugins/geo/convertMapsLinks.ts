/** Turns the Google Maps links in a block into `[[Place]]` wikilinks,
 *  creating (or reusing) the Place each one points at — the same Place
 *  and link the `@` autocomplete would produce, so the block lands on
 *  maps through its body reference. */

import type { EditorView } from '@codemirror/view'
import type { Repo } from '@/data/repo'
import { readBlockText, replaceBlockText } from './blockTextReplace'
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
  const result: MapsLinkConversion = {converted: 0, failures: []}
  const data = await repo.load(blockId)
  const text = await readBlockText(repo, blockId, view)
  if (!data || text === null) return result

  // One at a time: a name collision opens a toast that waits on the user.
  for (const link of findGoogleMapsLinks(text)) {
    const linkText = text.slice(link.from, link.to)
    try {
      const candidate = await resolveLink(link.url)
      // The lookup takes a while; don't mint a Place for a link the user
      // has since removed. (A removal during a collision prompt is
      // accepted: the prompt's choice is itself a deliberate action.)
      if (!(await readBlockText(repo, blockId, view))?.includes(linkText)) continue
      const place = await createOrFindPlaceInteractive(repo, data.workspaceId, candidate)
      if (!place) continue
      const replaced = await replaceBlockText({
        repo,
        blockId,
        view,
        span: link,
        text: linkText,
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
