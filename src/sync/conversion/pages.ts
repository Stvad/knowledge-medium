/**
 * Keyset paging over the server, the one way the conversion reads a whole
 * workspace. A pass can run for hours, so a read that fails for a moment is
 * retried rather than losing the pass, and a page that runs past the
 * statement timeout — a run of very large rows — is read again in halves.
 * Every read is by cursor, so a retried one returns the same rows.
 */

import { abortableSleep } from '@/utils/abortableSleep.js'
import { errorCodeOf } from './conversionServer.js'

const STATEMENT_TIMEOUT = '57014'
const READ_ATTEMPTS = 4

/** A failure worth trying again: PostgREST couldn't reach or wait for the
 *  database (`PGRST000`–`PGRST003`), or no answer came at all. Any other code
 *  is the database's verdict on the request, which a retry would repeat. */
const isTransient = (error: unknown): boolean => {
  const code = errorCodeOf(error) ?? ''
  if (code.startsWith('PGRST00')) return true
  if (code !== '') return false
  const status = (error as {status?: unknown} | null)?.status
  return typeof status !== 'number' || status === 0 || status >= 500
}

export interface PagesOptions<Row, Cursor> {
  readonly read: (after: Cursor, limit: number) => Promise<readonly Row[]>
  readonly first: Cursor
  readonly cursorOf: (row: Row) => Cursor
  readonly pageSize: number
  /** The cursor past which nothing is left to read, if one is known. */
  readonly done?: (after: Cursor) => boolean
  readonly signal?: AbortSignal
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Pages until one comes back empty: a page may be short before the end,
 *  since PostgREST caps the rows in a response. */
export async function* keysetPages<Row, Cursor>({
  read,
  first,
  cursorOf,
  pageSize,
  done,
  signal,
  sleep = abortableSleep,
}: PagesOptions<Row, Cursor>): AsyncGenerator<readonly Row[]> {
  let limit = pageSize
  for (let after = first; !done?.(after);) {
    signal?.throwIfAborted()
    let page: readonly Row[]
    // A smaller page after a statement timeout isn't a retry: only transient
    // failures spend the attempts.
    for (let attempt = 1; ;) {
      try {
        page = await read(after, limit)
        break
      } catch (error) {
        if (signal?.aborted) throw error
        if (errorCodeOf(error) === STATEMENT_TIMEOUT && limit > 1) {
          limit = Math.ceil(limit / 2)
          continue
        }
        if (!isTransient(error) || attempt >= READ_ATTEMPTS) throw error
        await sleep(1000 * 2 ** (attempt - 1), signal)
        attempt++
      }
    }
    if (page.length === 0) return
    yield page
    after = cursorOf(page[page.length - 1])
    limit = Math.min(pageSize, limit * 2)
  }
}
