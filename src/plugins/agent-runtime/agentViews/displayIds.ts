import { ellipsize } from './text.ts'

const MAX_DISPLAY_ID = 64

/** An id as a view prints it. A canonical id never reaches the bound; a
 *  longer one (only sync can deliver it) is clipped and so does not resolve
 *  back — accepted, `format: 'json'` carries it exactly. */
export const boundDisplayId = (id: string): string => ellipsize(id, MAX_DISPLAY_ID)

/** A block's id as a text view marks it: the whole id, the one every id
 *  field and every `((id))` in content takes. */
export const idMark = (id: string): string => `^${boundDisplayId(id)}`
