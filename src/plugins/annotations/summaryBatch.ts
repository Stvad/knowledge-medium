/**
 * Thread roots with their comment counts, answered for every root asked about
 * in the same microtask by ONE statement. Every rendered block resolves its
 * thread summaries in the same tick (the pill, the margin, the highlights),
 * so one read per root and one more per root's children would queue a wave's
 * worth of statements on the one- or two-connection read pool.
 *
 * The transport — coalescing, failure scope — is `@/data/internals/readBatch`.
 */

import type {QueryReadDb} from '@/data/api'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {ReadBatcher, readBatcherPerDb} from '@/data/internals/readBatch'
import {recognizedFieldRowSql, type RecognitionParams} from '@/data/internals/treeQueries'

export interface ThreadRootRow {
  row: Record<string, unknown>
  /** The root's visible children: its top-level comments. */
  commentCount: number
}

/** Bind `[...RecognitionParams, idsJson]`: the count's placeholders come
 *  first in the text. The count is the visible-children view
 *  `core.childIds({hidePropertyChildren: true})` takes. */
const THREAD_ROOTS_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')},
         (SELECT COUNT(*) FROM blocks c
           WHERE c.parent_id = b.id AND c.deleted = 0
             AND NOT (${recognizedFieldRowSql('c')})) AS km_comment_count
    FROM json_each(?) j
    JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

export class ThreadRootBatcher {
  private readonly batch: ReadBatcher<RecognitionParams, ThreadRootRow | null>

  /** Requests one statement can answer: the same recognition snapshot
   *  (`registryRecognitionParams` is cached per snapshot, so identity — the
   *  batcher's default — is the comparison). Unchunked: the ids bind as one
   *  JSON value. */
  constructor(db: QueryReadDb) {
    this.batch = new ReadBatcher(db, {
      read: async (recognitionParams, roots) => {
        const rows = await db.getAll<Record<string, unknown>>(
          THREAD_ROOTS_SQL, [...recognitionParams, JSON.stringify(roots)],
        )
        const answers = new Map<string, ThreadRootRow>()
        for (const {km_comment_count, ...row} of rows) {
          answers.set(row.id as string, {row, commentCount: Number(km_comment_count)})
        }
        return id => answers.get(id) ?? null
      },
    })
  }

  /** The root's row and comment count, or null for a missing or deleted row. */
  request(rootId: string, recognitionParams: RecognitionParams): Promise<ThreadRootRow | null> {
    return this.batch.request(rootId, recognitionParams)
  }
}

export const threadRootBatcherFor = readBatcherPerDb(db => new ThreadRootBatcher(db))
