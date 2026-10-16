import type { Repo } from '@/data/repo'
import { shortIds } from './resolveRef.ts'
import { ellipsize } from './text.ts'

const MAX_DISPLAY_ID = 64

/** An id as a view prints it. A canonical id never reaches the bound; a
 *  longer one (only sync can deliver it) is clipped and so does not resolve
 *  back — accepted, `format: 'json'` carries it exactly. */
export const boundDisplayId = (id: string): string => ellipsize(id, MAX_DISPLAY_ID)

/** {@link shortIds}, bounded for display: the one source of every id a
 *  text view prints. */
export const displayIds = async (repo: Repo, ids: Iterable<string>): Promise<Map<string, string>> => {
  const short = await shortIds(repo, ids)
  return new Map([...short].map(([id, display]) => [id, boundDisplayId(display)]))
}
