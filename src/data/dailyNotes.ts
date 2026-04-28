import { v5 as uuidv5 } from 'uuid'
import { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import { aliasProp, fromList, typeProp } from '@/data/properties'
import { dailyPageAliases, formatIsoDate } from '@/utils/dailyPage'

// Namespace UUIDs — fixed constants so two clients computing the same
// (workspaceId, isoDate) pair derive the same block id even before any
// sync has happened. Without this, two offline clients each create
// their own "today" page on first launch and we ship duplicate pages
// on first sync.
const JOURNAL_NS = 'a304a5da-807a-4c20-8af3-53a033aa9df8'
const DAILY_NOTE_NS = '53421e08-2f31-42f8-b73a-43830bb718f1'

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

const dailyNoteCreateTime = (iso: string): number => {
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
// for iso="2026-04-28" regardless of the user's timezone. (A naive
// `new Date(createTime)` would shift to the previous day for users
// west of UTC.)
const dailyNoteLocalDate = (iso: string): Date => {
  const {year, month, day} = parseIsoParts(iso)
  return new Date(year, month - 1, day)
}

// Look up by deterministic id, regardless of `deleted` flag, so the
// caller can decide whether to resurrect or treat as missing. Returns
// the cached/loaded BlockData (or undefined if no row).
const loadById = (repo: Repo, id: string) => repo.loadBlockData(id)

const ensureChildLink = (parent: Block, childId: string) => {
  const data = parent.dataSync()
  if (data?.childIds.includes(childId)) return
  parent.change((doc) => {
    if (!doc.childIds.includes(childId)) doc.childIds.push(childId)
  })
}

export const getOrCreateJournalBlock = async (
  repo: Repo,
  workspaceId: string,
): Promise<Block> => {
  const id = journalBlockId(workspaceId)
  const existing = await loadById(repo, id)
  if (existing) {
    const block = repo.find(id)
    if (existing.deleted) {
      block.change((doc) => { doc.deleted = false })
    }
    return block
  }

  return repo.create({
    id,
    workspaceId,
    content: JOURNAL_ALIAS,
    properties: fromList(
      aliasProp([JOURNAL_ALIAS]),
      {...typeProp, value: JOURNAL_TYPE},
    ),
  })
}

// `findDailyNote` only looks via the workspace-scoped alias index,
// which filters out soft-deleted rows. Returns null if the day's
// note doesn't exist or has been deleted.
export const findDailyNote = async (
  repo: Repo,
  workspaceId: string,
  iso: string,
): Promise<Block | null> => repo.findBlockByAliasInWorkspace(workspaceId, iso)

// Deterministic-id upsert path. Two clients calling concurrently with
// the same (workspaceId, iso) write to the same row, so the daily
// note never duplicates even when both clients are offline at boot.
//
// On a soft-deleted row we resurrect rather than re-create from
// scratch — the row's content/children may carry edits the user wants
// back. We also re-link to the journal because Block.delete() spliced
// the id out of the parent's childIds when the user soft-deleted it.
export const getOrCreateDailyNote = async (
  repo: Repo,
  workspaceId: string,
  iso: string,
): Promise<Block> => {
  // Reuse any live daily note found by alias before creating a fresh
  // deterministic-id row. Workspace seeders (seedDailyPage,
  // ensure_personal_workspace flows) install today's page under a
  // server-supplied UUID, not our deterministic one — without this
  // lookup we'd create a second row in the same workspace with the
  // same aliases and end up with a duplicate.
  const byAlias = await findDailyNote(repo, workspaceId, iso)
  if (byAlias) return byAlias

  const id = dailyNoteBlockId(workspaceId, iso)
  const existing = await loadById(repo, id)

  if (existing && !existing.deleted) {
    return repo.find(id)
  }

  const journal = await getOrCreateJournalBlock(repo, workspaceId)

  if (existing && existing.deleted) {
    const block = repo.find(id)
    block.change((doc) => {
      doc.deleted = false
      doc.parentId = journal.id
    })
    ensureChildLink(journal, id)
    return block
  }

  const [longLabel, isoLabel] = dailyPageAliases(dailyNoteLocalDate(iso))
  const created = repo.create({
    id,
    workspaceId,
    parentId: journal.id,
    content: longLabel,
    createTime: dailyNoteCreateTime(iso),
    properties: fromList(
      aliasProp([longLabel, isoLabel]),
      {...typeProp, value: DAILY_NOTE_TYPE},
    ),
  })
  ensureChildLink(journal, id)
  return created
}
