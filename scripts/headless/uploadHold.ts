import type {CommonPowerSyncDatabase} from '@powersync/common'
import {UploadHeldError} from '@/services/powersync'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const STALE_QUEUE_REASON = 'Stale upload queue. Downloads can reach the oplog, but checkpoints cannot apply until the queue drains.'

// Record the head in the transaction that changes it. An offline host can exit
// before PowerSync attempts an upload or delivers a table-change notification.
async function observeUploadHead(db: CommonPowerSyncDatabase) {
  const recordHead = 'INSERT OR IGNORE INTO headless_upload_head (entry_id) SELECT id FROM ps_crud ORDER BY id LIMIT 1'
  await db.writeTransaction(async tx => {
    await tx.execute(`CREATE TABLE IF NOT EXISTS headless_upload_head (
      entry_id INTEGER PRIMARY KEY,
      first_seen_ms INTEGER NOT NULL DEFAULT (round(unixepoch('subsec') * 1000))
    )`)
    await tx.execute(`CREATE TRIGGER IF NOT EXISTS headless_first_upload
      AFTER INSERT ON ps_crud WHEN NOT EXISTS (SELECT 1 FROM headless_upload_head)
      BEGIN INSERT INTO headless_upload_head (entry_id) VALUES (NEW.id); END`)
    await tx.execute(`CREATE TRIGGER IF NOT EXISTS headless_next_upload
      AFTER DELETE ON ps_crud WHEN OLD.id = (SELECT entry_id FROM headless_upload_head)
      BEGIN DELETE FROM headless_upload_head; ${recordHead}; END`)
    // A queue from an earlier host has its first observation at upgrade.
    await tx.execute(recordHead)
  })
}

type Head = {entry_id: number, first_seen_ms: number}

export async function openUploadHold(
  db: CommonPowerSyncDatabase, workspaceId: string, release: boolean, onChange: () => void,
) {
  await observeUploadHead(db)
  const readHead = () => db.getOptional<Head>('SELECT entry_id, first_seen_ms FROM headless_upload_head')
  const head = await readHead()
  const stale = (firstSeen: number) => Date.now() - firstSeen > WEEK_MS
  const releasedHead = release && head && stale(head.first_seen_ms) ? head.entry_id : null
  const shouldHold = (current: Head | null) =>
    current !== null && current.entry_id !== releasedHead && stale(current.first_seen_ms)
  let held = shouldHold(head)
  return {
    queuedAtBoot: head !== null,
    isHeld: () => held,
    async health() {
      const {queuedEntries, firstSeen} = await db.get<{queuedEntries: number, firstSeen: number | null}>(
        `SELECT (SELECT count(*) FROM ps_crud) AS queuedEntries,
                (SELECT first_seen_ms FROM headless_upload_head) AS firstSeen`,
      )
      return {queuedEntries, oldestQueuedAgeMs: firstSeen === null ? null : Date.now() - firstSeen,
        uploadHold: held ? STALE_QUEUE_REASON : null}
    },
    async beforeUploadBatch() {
      held = shouldHold(await readHead())
      onChange()
      if (held) throw new UploadHeldError(workspaceId, STALE_QUEUE_REASON)
    },
  }
}
