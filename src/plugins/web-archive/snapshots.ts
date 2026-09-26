/**
 * Reading and writing archive records.
 *
 * A record is a `webarchive-snapshot` block parented under the block whose
 * content carried the link, so the archived copy sits next to the original —
 * which is the point of the feature — and the association is a structural
 * edge rather than an id in a string property.
 *
 * All writes go through `ChangeScope.Automation`: durable and synced like any
 * write, but not in the user's undo stack. A Ctrl+Z after typing should undo
 * the typing, not silently unwind a background archive record.
 */

import { v4 as uuidv4 } from 'uuid'
import { ChangeScope, propertyValue, type BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { keyAtEnd } from '@/data/orderKey.js'
import { hasBlockType } from '@/data/properties.js'
import {
  ARCHIVE_SNAPSHOT_TYPE,
  archiveAttemptsProp,
  archiveErrorProp,
  archiveLastAttemptAtProp,
  archiveServiceProp,
  archiveSourceUrlProp,
  archiveStatusProp,
  archiveSubmittedAtProp,
  archiveUrlProp,
  type ArchiveStatus,
} from './schema.ts'

export interface ArchiveRecord {
  readonly id: string
  readonly parentId: string | null
  readonly url: string
  readonly archiveUrl: string
  readonly status: ArchiveStatus
  readonly serviceId: string
  readonly submittedAt: Date | undefined
  readonly lastAttemptAt: Date | undefined
  readonly attempts: number
  readonly error: string | undefined
}

const decode = <T>(
  data: BlockData,
  prop: {name: string; codec: {decode: (raw: unknown) => T}; defaultValue: T},
): T => {
  const raw = data.properties[prop.name]
  if (raw === undefined) return prop.defaultValue
  try {
    return prop.codec.decode(raw)
  } catch {
    // A hand-edited or partially-synced row shouldn't take down the drain
    // loop; fall back to the declared default and let the record be retried
    // or ignored on its merits.
    return prop.defaultValue
  }
}

export const toArchiveRecord = (data: BlockData): ArchiveRecord => ({
  id: data.id,
  parentId: data.parentId,
  url: decode(data, archiveSourceUrlProp),
  archiveUrl: decode(data, archiveUrlProp),
  status: decode(data, archiveStatusProp),
  serviceId: decode(data, archiveServiceProp),
  submittedAt: decode(data, archiveSubmittedAtProp),
  lastAttemptAt: decode(data, archiveLastAttemptAtProp),
  attempts: decode(data, archiveAttemptsProp),
  error: decode(data, archiveErrorProp),
})

export const isArchiveSnapshot = (
  data: Pick<BlockData, 'properties'>,
): boolean => hasBlockType(data, ARCHIVE_SNAPSHOT_TYPE)

/** Content for a record block, chosen so the row still says something useful
 *  in an outline with this plugin uninstalled. */
export const recordContent = (
  url: string,
  status: ArchiveStatus,
  archiveUrl: string,
): string => {
  if (status === 'archived' && archiveUrl) return `Archived ${url} → ${archiveUrl}`
  if (status === 'failed') return `Archiving failed: ${url}`
  if (status === 'skipped') return `Archiving skipped: ${url}`
  if (status === 'submitted') return `Submitted for archiving: ${url}`
  return `Queued for archiving: ${url}`
}

/** Every archive record in the workspace, newest first. Used by the settings
 *  panel, which wants the all-time totals; the drain loop deliberately does
 *  NOT use this — see `queryOpenRecords` / `querySubmittedSince`. */
export const queryAllRecords = async (
  repo: Repo,
  workspaceId: string,
): Promise<ArchiveRecord[]> => {
  const rows = await repo.queryBlocks({
    workspaceId,
    types: [ARCHIVE_SNAPSHOT_TYPE],
    order: 'created-desc',
  })
  return rows.map(toArchiveRecord)
}

/**
 * Records still needing work: queued, or submitted but not yet verified.
 *
 * Filtered in SQL as "not one of the terminal states" rather than by reading
 * every record and filtering in JS. The drain loop runs once a minute
 * forever; a graph with ten thousand archived links should not decode ten
 * thousand rows each time to find the two that need attention.
 */
export const queryOpenRecords = async (
  repo: Repo,
  workspaceId: string,
): Promise<ArchiveRecord[]> => {
  const rows = await repo.queryBlocks({
    workspaceId,
    types: [ARCHIVE_SNAPSHOT_TYPE],
    order: 'created-asc',
    exclude: [
      {where: {[archiveStatusProp.name]: 'archived'}},
      {where: {[archiveStatusProp.name]: 'failed'}},
      {where: {[archiveStatusProp.name]: 'skipped'}},
    ],
  })
  return rows.map(toArchiveRecord)
}

/** Records submitted at or after `since` — the rate-accounting window. */
export const querySubmittedSince = async (
  repo: Repo,
  workspaceId: string,
  since: Date,
): Promise<ArchiveRecord[]> => {
  const rows = await repo.queryBlocks({
    workspaceId,
    types: [ARCHIVE_SNAPSHOT_TYPE],
    where: {[archiveSubmittedAtProp.name]: {gte: since}},
  })
  return rows.map(toArchiveRecord)
}

/** URLs already recorded under `sourceId`, so a re-edit of the same block
 *  doesn't queue the same link twice. Keyed on the normalized URL that
 *  `hostPolicy.decideUrl` produced, which is what gets stored. */
export const recordedUrlsForSource = async (
  repo: Repo,
  workspaceId: string,
  sourceId: string,
): Promise<Set<string>> => {
  // Ancestor scope narrows the scan to `sourceId`'s subtree in SQL; the
  // `parentId` filter then keeps only its direct children. Parentage is the
  // link between a record and its source, so this is the honest query — no
  // redundant parent-id property invented just to make a shape work.
  const rows = await repo.queryBlocks({
    workspaceId,
    types: [ARCHIVE_SNAPSHOT_TYPE],
    match: [{scope: 'ancestor', id: sourceId}],
  })
  return new Set(
    rows
      .filter(row => row.parentId === sourceId)
      .map(row => decode(row, archiveSourceUrlProp)),
  )
}

export interface CreateRecordSpec {
  readonly sourceId: string
  readonly url: string
  readonly serviceId: string
}

/**
 * Queue URLs for archiving: one record block each, under their source block,
 * in one transaction so a batch lands atomically.
 *
 * This is `createTypedChild` open-coded, and it has to be: that helper runs
 * the `core.createChild` mutator, which is hard-scoped to
 * `ChangeScope.BlockDefault`, and these records must be `Automation`. Writing
 * them as undoable document edits would mean a Ctrl+Z straight after typing
 * pops the archive record — the processor's transaction is the most recent
 * one — instead of the edit the user meant to undo. Same three steps
 * (`tx.create` + type tag + one codec-aware property batch), same
 * `systemMint` insert startup-metrics uses for its machine-authored rows.
 */
export const createPendingRecords = async (
  repo: Repo,
  specs: readonly CreateRecordSpec[],
): Promise<string[]> => {
  if (specs.length === 0) return []
  const ids: string[] = []
  await repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    for (const spec of specs) {
      const parent = await tx.get(spec.sourceId)
      // The source block can be deleted between the commit that mentioned the
      // URL and this write; a record with no parent is not worth minting.
      if (!parent || parent.deleted) continue

      const last = await repo.db.getOptional<{order_key: string}>(
        'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key DESC LIMIT 1',
        [spec.sourceId],
      )
      const id = uuidv4()
      await tx.create({
        id,
        workspaceId: parent.workspaceId,
        parentId: spec.sourceId,
        orderKey: keyAtEnd(last?.order_key ?? null),
        content: recordContent(spec.url, 'pending', ''),
      }, {systemMint: true})
      await repo.addTypeInTx(tx, id, ARCHIVE_SNAPSHOT_TYPE, {}, typeSnapshot)
      await tx.setProperties(id, {
        set: [
          propertyValue(archiveSourceUrlProp, spec.url),
          propertyValue(archiveStatusProp, 'pending'),
          propertyValue(archiveServiceProp, spec.serviceId),
          propertyValue(archiveAttemptsProp, 0),
        ],
      })
      ids.push(id)
    }
  }, {scope: ChangeScope.Automation, description: 'Queue URLs for archiving'})
  return ids
}

export interface RecordUpdate {
  readonly status: ArchiveStatus
  readonly attempts: number
  readonly lastAttemptAt: Date
  readonly submittedAt?: Date
  readonly archiveUrl?: string
  readonly error?: string | undefined
}

/**
 * Advance one record. Content is rewritten alongside the properties so the
 * outline line and the property panel never disagree.
 *
 * A record the user deleted between the drain loop's query and this write is
 * a no-op, not an error: they threw the record away, and a `BlockNotFound`
 * escaping here would abort the rest of the batch mid-tick.
 */
export const updateRecord = async (
  repo: Repo,
  record: ArchiveRecord,
  update: RecordUpdate,
): Promise<void> => {
  const archiveUrl = update.archiveUrl ?? record.archiveUrl
  await repo.tx(async tx => {
    const current = await tx.get(record.id)
    if (!current || current.deleted) return
    await tx.update(record.id, {
      content: recordContent(record.url, update.status, archiveUrl),
    })
    await tx.setProperties(record.id, {
      set: [
        propertyValue(archiveStatusProp, update.status),
        propertyValue(archiveAttemptsProp, update.attempts),
        propertyValue(archiveLastAttemptAtProp, update.lastAttemptAt),
        ...(update.submittedAt ? [propertyValue(archiveSubmittedAtProp, update.submittedAt)] : []),
        ...(update.archiveUrl ? [propertyValue(archiveUrlProp, update.archiveUrl)] : []),
        ...(update.error ? [propertyValue(archiveErrorProp, update.error)] : []),
      ],
      // A retry that succeeds must clear the previous failure, or the record
      // reads as archived-and-broken forever.
      ...(update.error ? {} : {unset: [archiveErrorProp]}),
    })
  }, {scope: ChangeScope.Automation, description: 'Update archive record'})
}
