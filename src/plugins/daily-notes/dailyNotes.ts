import { ChangeScope, type BlockData, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { Block } from '@/data/block'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { getOrCreateKernelPage, kernelPageBlockId } from '@/data/kernelPage'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey'
import {
  createOrRestoreTargetBlock,
  partitionClaimableAliases,
  restorePropertiesStrippingAliases,
} from '@/data/targets'
import { parseAliasCollisionError } from '@/data/internals/raiseProtocol.js'
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
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: JOURNAL_NS,
    alias: JOURNAL_ALIAS,
    markerType: null,
  })

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
 *  cleanly.
 *
 *  Runs under `repo.undoGroup`: journal bootstrap + note create/repair
 *  can be two txs — one undo entry for the pair, for every caller
 *  (callers handing us their own group facade fold us into theirs).
 *
 *  NOT a kernel page, though it looks like one and the Journal above IS
 *  one. The difference is that this row has a SECOND writer at the same
 *  derived id: `ensureDailyNoteTarget` materialises it seat-shaped at
 *  workspace root (content = iso, aliases = [iso]) when a `[[2026-07-24]]`
 *  reference resolves before anyone opened the day. So the "repair" branch
 *  below is not maintenance — it is the promotion of a seat-shaped row into
 *  a note-shaped one, which is why it checks `parentId`/`orderKey` and
 *  MERGES aliases rather than replacing them. A kernel page has one writer
 *  and one shape and can never grow those checks, so folding this into
 *  `getOrCreateKernelPage` would park seat-reconciliation behind a flag its
 *  other callers can't reach. */
export const getOrCreateDailyNote = async (
  repo: Repo,
  workspaceId: string,
  iso: string,
): Promise<Block> => repo.undoGroup(async repo => {
  const id = dailyNoteBlockId(workspaceId, iso)
  const orderKey = dailyNoteOrderKey(iso)
  const [longLabel, isoLabel] = dailyPageAliases(dailyNoteLocalDate(iso))
  const dailyAliases = [longLabel, isoLabel]
  const dateValue = dailyNoteDateValue(iso)

  /** Same guard, and the same reasoning, as `getOrCreateKernelPage`'s: neither
   *  read below is workspace-scoped (`repo.load` and `tx.get` both select on id
   *  alone), and what they feed rewrites aliases and types, resurrects
   *  tombstones, and — uniquely here — `tx.move`s the row under THIS
   *  workspace's Journal, which would tear a page out of someone else's tree.
   *
   *  Worth being honest about reachability, because it differs from the kernel
   *  page's by which half: `DAILY_NOTE_NS` is app-owned and the key already
   *  carries the workspace, so a foreign occupant at rest needs a uuid
   *  collision or a hand-written id. The window between `repo.load` and the
   *  transaction is not hypothetical though — sync materialization rewrites
   *  `workspace_id` along with every other column, so the row can change hands
   *  mid-call whatever the namespace. */
  const refuseForeign = (occupant: BlockData): void => {
    if (classifyOccupant(occupant, {workspaceId}).verdict === 'foreign') {
      throw new DeterministicIdCrossWorkspaceError(id, occupant.workspaceId, workspaceId)
    }
  }

  const live = await repo.load(id)
  if (live) {
    refuseForeign(live)
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
      refuseForeign(current)
      const currentAliases = stringListProperty(current.properties[aliasesProp.name])
      const claimable = await partitionClaimableAliases(tx, id, dailyAliases, workspaceId)
      const merged = mergeStrings([...claimable, ...currentAliases])
      // Compare against the MERGED set, not the canonical one: while an alias
      // stays contested `needsRepair` is true on every call, so comparing
      // against `dailyAliases` would rewrite the same value on every
      // navigation to the day.
      if (!includesAll(currentAliases, merged)) {
        await tx.setProperty(id, aliasesProp, merged)
      }
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: claimable}, typeSnapshot)
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
    if (existing) refuseForeign(existing)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      // The tombstone's stored alias bag can hold an entry a different
      // live block claimed while the daily note was dead (issue #378) —
      // restoring it as-is would re-insert that stale claim and abort
      // the whole tx. Strip it here; the setProperty below re-claims
      // exactly the canonical long-form + ISO aliases.
      const restoredProperties = await restorePropertiesStrippingAliases(tx, id)
      // Resurrecting a tombstone must not RENAME it. A seat materialised from a
      // `[[2026-04-28]]` wikilink has the ISO text as its content, so writing
      // the long-form label here reads to `alias.sync` as a rename: its rule 1
      // sees the old content still in the alias list and replaces that entry
      // with the new content. The day then comes back without the ISO alias it
      // is addressed by — and if another page owns the long-form name, the
      // preflight rejects, the whole tx rolls back, the row stays tombstoned,
      // and every retry repeats. Only an EMPTY title is worth filling in, which
      // is also what the live-repair branch above does (it never touches
      // content); promotion to the long-form label is not restore's business.
      await tx.restore(id, {
        ...(existing.content === '' ? {content: longLabel} : {}),
        properties: restoredProperties,
      })
      const claimable = await partitionClaimableAliases(tx, id, dailyAliases, workspaceId)
      await tx.setProperty(id, aliasesProp, claimable)
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: claimable}, typeSnapshot)
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
    const claimable = await partitionClaimableAliases(tx, id, dailyAliases, workspaceId)
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: claimable}, typeSnapshot)
    await repo.addTypeInTx(
      tx, id, DAILY_NOTE_TYPE,
      {[dailyNoteDateProp.name]: dateValue},
      typeSnapshot,
    )
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
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

/** "Which daily note is this?", or `null` for a block that isn't one. The one
 *  definition of that read, shared by the prev/next keyboard actions (which
 *  peek both values off a Block) and the title date-nav arrows (which take them
 *  from reactive hooks).
 *
 *  The typed `daily-note:date` property first, the ISO alias only as a
 *  fallback. An alias is user-editable AND withholdable: a day whose ISO name
 *  another live page already claims yields it rather than fighting for it,
 *  because claiming it aborts the transaction the page is created in. Reading
 *  identity out of the alias list then reports that page as not a daily note at
 *  all — no date arrows, and prev/next stepping from TODAY rather than from the
 *  day on screen, silently. The property is written on both creation paths
 *  (`getOrCreateDailyNote` and `ensureDailyNoteTarget`) and backfilled per
 *  device for older rows, which is what the fallback is still there for.
 *
 *  `isValidDateAlias`, NOT `isDateAlias`: a date-SHAPED alias that isn't a
 *  calendar day (`2026-02-30`) belongs to an ordinary alias-target page — the
 *  references processor routes it to `ensureAliasTarget` precisely because
 *  `parseLiteralDailyPageTitle` rejects it. Treating such an alias as the
 *  block's date hands a normal page the daily-note affordances, and
 *  `addDaysIso` then reads it as March 2nd — so "previous day" lands on
 *  2026-03-01, forward by a month. Callers fall back to today instead, the
 *  same as on any other non-daily page. The property goes through the same gate
 *  rather than being trusted: it is a plain date cell a user or an import can
 *  write anything into.
 *
 *  Deliberately NOT a `DAILY_NOTE_TYPE` check: that would couple these read
 *  paths to type-tagging having reached every historical row. */
export const dailyNoteIso = (
  {date, aliases}: {date?: Date | undefined; aliases?: readonly string[]},
): string | null => {
  if (date !== undefined && !Number.isNaN(date.getTime())) {
    // UTC, matching `dailyNoteDateValue`'s midnight-UTC write. Reading it in
    // local time shifts the day by one for anyone west of Greenwich.
    const iso = date.toISOString().slice(0, 10)
    if (isValidDateAlias(iso)) return iso
  }
  return aliases?.find(isValidDateAlias) ?? null
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
    const encoded = seat.properties[aliasesProp.name]
    existing = encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
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
