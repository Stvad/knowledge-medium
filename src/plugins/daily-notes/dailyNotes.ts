import { ChangeScope, type BlockData, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { Block } from '@/data/block'
import { applyTypeTagInTx } from '@/data/typeTagger'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { getOrCreateKernelPage, kernelPageBlockId, type KernelPageSpec } from '@/data/kernelPage'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey'
import { createOrRestoreTargetBlock, restorePropertiesStrippingAliases } from '@/data/targets'
import { parseAliasCollisionError } from '@/data/internals/raiseProtocol.js'
import { decodeRowProperty } from '@/data/rowProperty'
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

export const journalPageSpec: KernelPageSpec = {
  namespace: JOURNAL_NS,
  alias: JOURNAL_ALIAS,
  markerType: null,
}

export const journalBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, JOURNAL_NS)

export const dailyNoteBlockId = (workspaceId: string, iso: string): string =>
  derivedBlockId({namespace: DAILY_NOTE_NS, key: `${workspaceId}:${iso}`})

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

const stringListProperty = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

const includesAll = (existing: readonly string[], expected: readonly string[]): boolean =>
  expected.every(value => existing.includes(value))

const mergeStrings = (values: readonly string[]): string[] => Array.from(new Set(values))

/** Get-or-create the workspace's Journal page.
 *
 *  The Journal is a kernel page — deterministic id from `workspaceId`, a
 *  reserved alias, restored when soft-deleted, repaired when it has lost
 *  its type or alias. So it IS one, rather than carrying its own copy of
 *  that logic.
 *
 *  It is the one kernel page with no marker type: the Journal is reached
 *  by its derived id and by its alias, never by a
 *  `subscribeBlocks({types})` query. Giving it a marker now would mean
 *  tagging every Journal row already written, which is a migration and
 *  not this function's business. */
export const getOrCreateJournalBlock = async (
  repo: Repo,
  workspaceId: string,
): Promise<Block> =>
  // A container of every device's daily notes, so its create never joins an
  // undo step (see `getOrCreateKernelPage`): undoing a day's first note leaves
  // the Journal.
  getOrCreateKernelPage(repo, workspaceId, journalPageSpec, {skipUndo: true})

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

const dailyNoteShape = (workspaceId: string, iso: string) => {
  const date = dailyNoteDateValue(iso)
  const [title] = dailyPageAliases(new Date(`${iso}T12:00:00`))
  return {id: dailyNoteBlockId(workspaceId, iso), date, title, aliases: [title, iso], orderKey: dailyNoteOrderKey(iso)}
}

type DailyNoteShape = ReturnType<typeof dailyNoteShape>

const checkNoteWorkspace = (row: BlockData, workspaceId: string) => {
  if (classifyOccupant(row, {workspaceId}).verdict === 'foreign') {
    throw new DeterministicIdCrossWorkspaceError(row.id, row.workspaceId, workspaceId)
  }
}

const noteIsReady = (row: BlockData, shape: DailyNoteShape, parentId: string | null) =>
  row.parentId === parentId && row.orderKey === shape.orderKey &&
  hasBlockType(row, PAGE_TYPE) && hasBlockType(row, DAILY_NOTE_TYPE) &&
  includesAll(stringListProperty(row.properties[aliasesProp.name]), shape.aliases) &&
  row.properties[dailyNoteDateProp.name] === shape.date.toISOString()

/** A property write may precede eager Journal bootstrap. A note can live at
 *  the root until navigation files it. Minting the shared Journal inside the
 *  property edit would let undo remove a container used by other devices. */
export const getOrCreateDailyNoteInTx = async (
  tx: Tx, snapshot: TypeRegistrySnapshot, workspaceId: string, iso: string,
): Promise<string> => {
  const shape = dailyNoteShape(workspaceId, iso)
  const {id, date, title, aliases, orderKey} = shape
  const journal = await tx.get(journalBlockId(workspaceId))
  if (journal) checkNoteWorkspace(journal, workspaceId)
  const parentId = journal && !journal.deleted ? journal.id : null
  const existing = await tx.get(id)
  if (existing) {
    checkNoteWorkspace(existing, workspaceId)
    if (noteIsReady(existing, shape, parentId) && !existing.deleted) return id
    const storedDate = existing.properties[dailyNoteDateProp.name]
    if (storedDate !== undefined && storedDate !== date.toISOString()) {
      throw new Error(`Cannot use the daily note for ${iso}: its stored date differs`)
    }
    if (existing.deleted) {
      const properties = await restorePropertiesStrippingAliases(tx, id)
      await tx.restore(id, {content: title, properties})
    }
    const held = existing.deleted ? [] : stringListProperty(existing.properties[aliasesProp.name])
    if (!includesAll(held, aliases)) await tx.setProperty(id, aliasesProp, mergeStrings([...aliases, ...held]))
    if (existing.parentId !== parentId || existing.orderKey !== orderKey) {
      await tx.move(id, {parentId, orderKey}, {skipMetadata: true})
    }
  } else {
    await tx.create({id, workspaceId, parentId, orderKey, content: title}, {systemMint: true})
  }
  await applyTypeTagInTx(tx, snapshot, {blockId: id, typeId: PAGE_TYPE, initialValues: {[aliasesProp.name]: aliases}})
  await applyTypeTagInTx(tx, snapshot, {blockId: id, typeId: DAILY_NOTE_TYPE, initialValues: {[dailyNoteDateProp.name]: date}})
  return id
}

/** The Journal bootstraps outside the undoable note edit. A fully shaped
 *  live note is a read-only fast path, including when reopened offline. */
export const getOrCreateDailyNote = async (
  repo: Repo, workspaceId: string, iso: string, {description}: {description?: string} = {},
): Promise<Block> => repo.undoGroup(async repo => {
  const shape = dailyNoteShape(workspaceId, iso)
  const live = await repo.load(shape.id)
  if (live) {
    checkNoteWorkspace(live, workspaceId)
    if (noteIsReady(live, shape, journalBlockId(workspaceId))) return repo.block(shape.id)
  }
  await getOrCreateJournalBlock(repo, workspaceId)
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(tx => getOrCreateDailyNoteInTx(tx, snapshot, workspaceId, iso),
    {scope: ChangeScope.BlockDefault, description})
  return repo.block(shape.id)
})

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

/** "Which daily note is this?" from a block's alias list — the ISO alias
 *  `getOrCreateDailyNote` writes via `dailyPageAliases`, or `null` for a block
 *  that isn't a daily note. The one definition of that read, shared by the
 *  prev/next keyboard actions (which peek it off a Block) and the title
 *  date-nav arrows (which get it from a reactive `aliases` hook).
 *
 *  `isValidDateAlias`, NOT `isDateAlias`: a date-SHAPED alias that isn't a
 *  calendar day (`2026-02-30`) belongs to an ordinary alias-target page — the
 *  references processor routes it to `ensureAliasTarget` precisely because
 *  `parseLiteralDailyPageTitle` rejects it. Treating such an alias as the
 *  block's date hands a normal page the daily-note affordances, and
 *  `addDaysIso` then reads it as March 2nd — so "previous day" lands on
 *  2026-03-01, forward by a month. Callers fall back to today instead, the
 *  same as on any other non-daily page.
 *
 *  Deliberately NOT a `DAILY_NOTE_TYPE` check: the ISO alias is the marker
 *  every daily-note writer sets, and gating on the type instead would couple
 *  these read paths to type-tagging having reached every historical row. */
export const dailyNoteIsoFromAliases = (
  aliases: readonly string[],
): string | null => aliases.find(isValidDateAlias) ?? null

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
): Promise<{ id: string; inserted: boolean }> => {
  // Lookup-first INSIDE the tx (mirrors ensureAliasTarget): the caller's
  // read-phase lookup can go stale between plan build and apply — a live
  // block that claimed the ISO alias in that gap would collide with the
  // setProperty below on the alias-uniqueness trigger and roll back the
  // whole write tx (found by referencesRecompute.fuzz.test.ts).
  const claimant = await tx.aliasLookup(date, workspaceId)
  if (claimant !== null) return {id: claimant.id, inserted: false}
  const result = await createOrRestoreTargetBlock(tx, {
    id: dailyNoteBlockId(workspaceId, date),
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: date,
    stripAliasesOnRestore: true,
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
  if (!result.inserted) {
    // Live-row hit: createOrRestoreTargetBlock runs `onInsertedOrRestored`
    // (which claims the ISO alias) only on insert/restore, NOT when the
    // seat already exists live. A seat whose ISO alias was cleared while it
    // stayed live (a direct alias edit on the daily page) would then never
    // reclaim it — leaving the date unowned so an unrelated block can claim
    // it, splitting the date's identity between the seat (bound by
    // content-refs via the deterministic id) and the new claimant (via
    // block_aliases): the LIVE-LIVE stable-wrong-binding the sweep forbids
    // (found by referencesRecompute.fuzz.test.ts). The in-tx `aliasLookup`
    // above proved the ISO is unclaimed here, so re-assert it if missing —
    // append (not replace), since the seat may hold long-form literals
    // claimed via claimLiteralDateAliases.
    await ensureSeatClaimsIso(tx, result.id, date)
  }
  return result
}

/** Append `iso` to the seat's alias list if absent. Precondition: the
 *  caller proved `iso` is unclaimed in this tx, so the ISO insert itself
 *  can't collide. A malformed alias property is left untouched —
 *  replacing it would drop entries the block_aliases trigger still
 *  indexes, worse than leaving the ISO unclaimed. */
const ensureSeatClaimsIso = async (tx: Tx, id: string, iso: string): Promise<void> => {
  const seat = await tx.get(id)
  if (seat === null || seat.deleted) return
  let existing: readonly string[]
  try {
    existing = decodeRowProperty(seat, aliasesProp)
  } catch {
    return
  }
  if (existing.includes(iso)) return
  try {
    await tx.setProperty(id, aliasesProp, [...existing, iso], {skipMetadata: true})
  } catch (err) {
    // Swallow ONLY alias-collision aborts (mirrors claimLiteralDateAliases,
    // referencesProcessor.ts). setProperty rewrites the whole `alias`
    // property, so the block_aliases trigger re-inserts every PRE-EXISTING
    // alias before adding the ISO — and a pre-existing alias that's latently
    // duplicated on another live block (a cross-client dupe synced in
    // trigger-free, clientSchema.ts) collides on RE-insert. Letting that
    // propagate would roll back the whole reference-parse tx (references for
    // every other changed row) and recur on every re-edit — a silent recompute
    // outage keyed to someone else's dupe. RAISE backs out only this
    // statement, so degrade to leaving the ISO unclaimed for this seat. The
    // ISO append can't be the colliding row: the caller's in-tx aliasLookup
    // proved it unclaimed and `existing` doesn't contain it.
    if (parseAliasCollisionError(err) === null) throw err
  }
}
