import { v5 as uuidv5 } from 'uuid'
import { ChangeScope } from '@/data/api'
import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import { aliasesProp, typeProp } from '@/data/properties'
import { dailyPageAliases, formatIsoDate } from '@/utils/dailyPage'

// Namespace UUIDs — fixed constants so two clients computing the same
// (workspaceId, isoDate) pair derive the same block id even before any
// sync has happened. Without this, two offline clients each create
// their own "today" page on first launch and we ship duplicate pages
// on first sync.
//
// DAILY_NOTE_NS is mirrored by `v_daily_note_ns` in
// supabase/migrations/<...>_deterministic_seed_daily_note.sql so that
// the server-seeded root block id matches what client-side
// dailyNoteBlockId() computes. The input format
// (`workspace_id || ':' || iso`) is mirrored there too. Drift between
// the two — namespace, input shape, or order — reintroduces the
// duplication.
export const JOURNAL_NS = 'a304a5da-807a-4c20-8af3-53a033aa9df8'
export const DAILY_NOTE_NS = '53421e08-2f31-42f8-b73a-43830bb718f1'

const JOURNAL_ALIAS = 'Journal'
const JOURNAL_TYPE = 'journal'
const DAILY_NOTE_TYPE = 'daily-note'

export const journalBlockId = (workspaceId: string): string =>
  uuidv5(workspaceId, JOURNAL_NS)

export const dailyNoteBlockId = (workspaceId: string, iso: string): string =>
  uuidv5(`${workspaceId}:${iso}`, DAILY_NOTE_NS)

export const todayIso = (now: Date = new Date()): string =>
  formatIsoDate(now)

const parseIsoParts = (iso: string): {year: number, month: number, day: number} => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new Error(`Invalid ISO date for daily note: ${iso}`)
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3])}
}

const dailyNoteCreatedAt = (iso: string): number => {
  // Stable across clients: midnight UTC of the wall-clock day. Keeps
  // chronological sort under the journal deterministic regardless of
  // who created the row first or what their local TZ is.
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date for daily note: ${iso}`)
  }
  return ms
}

// Build the Date used to render display aliases. Uses local-midnight
// of the same calendar day so dailyPageAliases — which reads
// .getDate() / .getMonth() in local TZ — produces "April 28th, 2026"
// for iso="2026-04-28" regardless of the user's timezone.
const dailyNoteLocalDate = (iso: string): Date => {
  const {year, month, day} = parseIsoParts(iso)
  return new Date(year, month - 1, day)
}

/** Get-or-create the workspace's Journal page. Idempotent: a
 *  deterministic id derived from `workspaceId` means two clients
 *  booting offline converge on the same row. Soft-deleted journal
 *  rows are restored. */
export const getOrCreateJournalBlock = async (
  repo: Repo,
  workspaceId: string,
): Promise<Block> => {
  const id = journalBlockId(workspaceId)
  const live = await repo.load(id)
  if (live && !live.deleted) return repo.block(id)

  await repo.tx(async tx => {
    // Re-read inside the tx with the unfiltered `tx.get` so we see
    // tombstones (`repo.load` filtered them out as null).
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: JOURNAL_ALIAS})
      await tx.setProperty(id, aliasesProp, [JOURNAL_ALIAS])
      await tx.setProperty(id, typeProp, JOURNAL_TYPE)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: JOURNAL_ALIAS,
      properties: {
        [aliasesProp.name]: aliasesProp.codec.encode([JOURNAL_ALIAS]),
        [typeProp.name]: typeProp.codec.encode(JOURNAL_TYPE),
      },
    })
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}

/** Order key under the journal page. Using the ISO date directly is
 *  deterministic across clients (no need for `dailyNoteCreatedAt`
 *  trickery on creation timestamps) and sorts chronologically by
 *  string compare. Each daily note has a unique date, so there's
 *  never a collision; if a future caller wants to insert *between*
 *  daily notes they can compute a fractional key from this base. */
const dailyNoteOrderKey = (iso: string): string => iso

/** Get-or-create today's daily note. Two clients calling concurrently
 *  with the same (workspaceId, iso) write to the same row, so the
 *  daily note never duplicates even when both are offline at boot.
 *
 *  On a soft-deleted row we resurrect rather than recreate from
 *  scratch — the row's content + descendant subtree may carry edits
 *  the user wants back. We also re-link to the journal because the
 *  resurrected row's parent_id may have drifted; `tx.move` sets it
 *  cleanly. */
export const getOrCreateDailyNote = async (
  repo: Repo,
  workspaceId: string,
  iso: string,
): Promise<Block> => {
  const id = dailyNoteBlockId(workspaceId, iso)
  const live = await repo.load(id)
  if (live && !live.deleted) return repo.block(id)

  const journal = await getOrCreateJournalBlock(repo, workspaceId)
  const [longLabel, isoLabel] = dailyPageAliases(dailyNoteLocalDate(iso))
  const orderKey = dailyNoteOrderKey(iso)

  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: longLabel})
      await tx.setProperty(id, aliasesProp, [longLabel, isoLabel])
      await tx.setProperty(id, typeProp, DAILY_NOTE_TYPE)
      // Re-parent under the journal in case the prior tombstoned row
      // had drifted. tx.move sets parent_id + order_key in one
      // primitive (with engine cycle check on parent_id mutation).
      await tx.move(id, {parentId: journal.id, orderKey}, {skipMetadata: true})
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: journal.id,
      orderKey,
      content: longLabel,
      properties: {
        [aliasesProp.name]: aliasesProp.codec.encode([longLabel, isoLabel]),
        [typeProp.name]: typeProp.codec.encode(DAILY_NOTE_TYPE),
      },
    })
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}

// `dailyNoteCreatedAt` retained for callers that need a stable wall-
// clock midnight for historical analysis; not used by the journal-
// sort path anymore (orderKey carries that responsibility now).
export {dailyNoteCreatedAt}
