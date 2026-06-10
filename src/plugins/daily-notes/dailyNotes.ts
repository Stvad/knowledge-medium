import { v5 as uuidv5 } from 'uuid'
import { ChangeScope, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey'
import { createOrRestoreTargetBlock } from '@/data/targets'
import { dailyPageAliases, formatIsoDate } from '@/utils/dailyPage'
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from './schema.ts'

/** Build the indexable `Date` stored on `dailyNoteDateProp`. The
 *  daily-note id is a hash of (workspaceId, iso) and not reversible,
 *  so this is the canonical place that re-derives "what day is this"
 *  for the query layer. UTC midnight keeps `toISOString()` stable
 *  across clients regardless of local timezone — same invariant the
 *  reverse-chronology orderKey relies on.
 *
 *  Throws on invalid input. Callers must validate via `isValidDateAlias`
 *  upstream — the references-processor routing decision is the canonical
 *  gate, so reaching this with a bad iso is a caller bug. */
export const dailyNoteDateValue = (iso: string): Date => {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date for daily note: ${iso}`)
  }
  const d = new Date(ms)
  // `Date.parse('2026-02-30T00:00:00Z')` rolls over to March 2 instead
  // of returning NaN in V8, so the NaN check alone isn't enough.
  if (d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid calendar date for daily note: ${iso}`)
  }
  return d
}

// Namespace UUIDs — fixed constants so two clients computing the same
// (workspaceId, isoDate) pair derive the same block id even before any
// sync has happened. Without this, two offline clients each create
// their own "today" page on first launch and we ship duplicate pages
// on first sync.
export const JOURNAL_NS = 'a304a5da-807a-4c20-8af3-53a033aa9df8'
export const DAILY_NOTE_NS = '53421e08-2f31-42f8-b73a-43830bb718f1'

const JOURNAL_ALIAS = 'Journal'
const JOURNAL_ALIASES = [JOURNAL_ALIAS]

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
  // Stable across clients: midnight UTC of the wall-clock day.
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date for daily note: ${iso}`)
  }
  return ms
}

export const addDaysIso = (iso: string, days: number): string => {
  const {year, month, day} = parseIsoParts(iso)
  return formatIsoDate(new Date(year, month - 1, day + days))
}

// Build the Date used to render display aliases. Uses local-midnight
// of the same calendar day so dailyPageAliases — which reads
// .getDate() / .getMonth() in local TZ — produces "April 28th, 2026"
// for iso="2026-04-28" regardless of the user's timezone.
const dailyNoteLocalDate = (iso: string): Date => {
  const {year, month, day} = parseIsoParts(iso)
  return new Date(year, month - 1, day)
}

const stringListProperty = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

const includesAll = (existing: readonly string[], expected: readonly string[]): boolean =>
  expected.every(value => existing.includes(value))

const mergeStrings = (values: readonly string[]): string[] => Array.from(new Set(values))

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
  if (live) {
    const aliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      !hasBlockType(live, PAGE_TYPE) ||
      !includesAll(aliases, JOURNAL_ALIASES)
    if (!needsRepair) return repo.block(id)

    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current || current.deleted) return
      const currentAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(currentAliases, JOURNAL_ALIASES)) {
        await tx.setProperty(id, aliasesProp, mergeStrings([...JOURNAL_ALIASES, ...currentAliases]))
      }
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: JOURNAL_ALIASES}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(id)
  }

  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    // Re-read inside the tx with the unfiltered `tx.get` so we see
    // tombstones (`repo.load` filtered them out as null).
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: JOURNAL_ALIAS})
      await tx.setProperty(id, aliasesProp, JOURNAL_ALIASES)
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: JOURNAL_ALIASES}, typeSnapshot)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: JOURNAL_ALIAS,
    }, {systemMint: true})
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: JOURNAL_ALIASES}, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}

/** Order key under the journal page. The tree uses normal ascending
 *  `(order_key, id)` ordering, so daily notes encode the date as its
 *  lexical complement: newer ISO dates sort before older ISO dates
 *  without a journal-specific query sort. Each daily note has a unique
 *  date, so there's never a collision. */
const dailyNoteOrderKey = (iso: string): string => {
  const {year, month, day} = parseIsoParts(iso)
  const reverseYear = String(9999 - year).padStart(4, '0')
  const reverseMonth = String(12 - month).padStart(2, '0')
  const reverseDay = String(31 - day).padStart(2, '0')
  return `${reverseYear}-${reverseMonth}-${reverseDay}`
}

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
  const orderKey = dailyNoteOrderKey(iso)
  const [longLabel, isoLabel] = dailyPageAliases(dailyNoteLocalDate(iso))
  const dailyAliases = [longLabel, isoLabel]
  const dateValue = dailyNoteDateValue(iso)
  const live = await repo.load(id)
  if (live) {
    const aliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      live.parentId !== journalBlockId(workspaceId) ||
      live.orderKey !== orderKey ||
      !hasBlockType(live, PAGE_TYPE) ||
      !hasBlockType(live, DAILY_NOTE_TYPE) ||
      !includesAll(aliases, dailyAliases)
    if (!needsRepair) {
      return repo.block(id)
    }
    const journal = await getOrCreateJournalBlock(repo, workspaceId)
    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current || current.deleted) return
      const currentAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(currentAliases, dailyAliases)) {
        await tx.setProperty(id, aliasesProp, mergeStrings([...dailyAliases, ...currentAliases]))
      }
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: dailyAliases}, typeSnapshot)
      await repo.addTypeInTx(
        tx, id, DAILY_NOTE_TYPE,
        {[dailyNoteDateProp.name]: dateValue},
        typeSnapshot,
      )
      if (current.parentId !== journal.id || current.orderKey !== orderKey) {
        await tx.move(id, {parentId: journal.id, orderKey}, {skipMetadata: true})
      }
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(id)
  }

  const journal = await getOrCreateJournalBlock(repo, workspaceId)

  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: longLabel})
      await tx.setProperty(id, aliasesProp, dailyAliases)
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: dailyAliases}, typeSnapshot)
      await repo.addTypeInTx(
        tx, id, DAILY_NOTE_TYPE,
        {[dailyNoteDateProp.name]: dateValue},
        typeSnapshot,
      )
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
    }, {systemMint: true})
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: dailyAliases}, typeSnapshot)
    await repo.addTypeInTx(
      tx, id, DAILY_NOTE_TYPE,
      {[dailyNoteDateProp.name]: dateValue},
      typeSnapshot,
    )
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}

// `dailyNoteCreatedAt` retained for callers that need a stable wall-
// clock midnight for historical analysis; not used by the journal-
// sort path anymore (orderKey carries that responsibility now).
export {dailyNoteCreatedAt}

/** Date-shaped alias detector (spec §7.6). Shape-only — matches the
 *  `YYYY-MM-DD` regex without checking calendar validity. Reach for
 *  this when you want to find any date-looking alias on a row
 *  (e.g. extracting the iso from a daily-note's alias list) and the
 *  caller will tolerate a malformed-but-shaped result. Routing
 *  decisions (references processor) use `isValidDateAlias` instead. */
export const isDateAlias = (alias: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(alias)

/** Shape + calendar-validity check. Returns `true` only for strings
 *  that parse to a real calendar day (rejects `2026-13-01`,
 *  `2026-02-30`, etc. via a round-trip-to-ISO comparison — naive
 *  `Date.parse` rolls these over silently). This is the routing
 *  predicate: aliases that pass go through `ensureDailyNoteTarget`
 *  (deterministic-id daily-note seat); aliases that only pass the
 *  shape check fall through to `ensureAliasTarget` (regular alias
 *  target page) so the user's typo doesn't pollute the daily-note
 *  namespace with a wrong-but-deterministic seat. */
export const isValidDateAlias = (alias: string): boolean => {
  if (!isDateAlias(alias)) return false
  const ms = Date.parse(`${alias}T00:00:00Z`)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === alias
}

/** Ensure a daily-note **target seat** block exists for ISO date `date`
 *  in `workspaceId`. The seat is a reference target materialised at
 *  workspace-root when nobody has authored a real daily-note row for
 *  that date yet — same `dailyNoteBlockId(workspaceId, date)` namespace
 *  as `getOrCreateDailyNote`, so the two flows converge on the same
 *  row through PowerSync without a merge.
 *
 *  Contract: `date` MUST be a valid calendar ISO (`isValidDateAlias`).
 *  The references-processor routing gate enforces this; callers
 *  invoking this directly are responsible for the same. Invalid input
 *  throws via `dailyNoteDateValue`.
 *
 *  Distinct from `getOrCreateDailyNote`, which parents the row under
 *  the Journal page and writes long-form aliases. `ensureDailyNoteTarget`
 *  is the lighter-weight materialiser invoked from `parseReferences`
 *  during reference resolution; it leaves the row at workspace-root
 *  with the iso date as content (matches the alias — mirrors
 *  `ensureAliasTarget`'s creation-time-default rule) until
 *  `getOrCreateDailyNote` later promotes it with the long-form label. */
export const ensureDailyNoteTarget = async (
  tx: Tx,
  repo: Repo,
  date: string,
  workspaceId: string,
  typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries(),
): Promise<{ id: string; inserted: boolean }> =>
  createOrRestoreTargetBlock(tx, {
    id: dailyNoteBlockId(workspaceId, date),
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: date,
    // A daily-note seat materialized from a reference is a speculative
    // default — it must yield to a real daily-note row the server already
    // has for this date.
    systemMint: true,
    onInsertedOrRestored: async (tx, id) => {
      await tx.setProperty(id, aliasesProp, [date])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [date]}, typeSnapshot)
      await repo.addTypeInTx(
        tx, id, DAILY_NOTE_TYPE,
        {[dailyNoteDateProp.name]: dailyNoteDateValue(date)},
        typeSnapshot,
      )
    },
  })
