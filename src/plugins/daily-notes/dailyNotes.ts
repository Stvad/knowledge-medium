import { ChangeScope, type BlockData, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { Block } from '@/data/block'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { getOrCreateKernelPage, kernelPageBlockId } from '@/data/kernelPage'
import type { Repo } from '@/data/repo'
import { aliasesProp, getAliases, getBlockTypes, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey'
import {
  type CanonicalAdoptionGuard,
  canonicalAliasReaderFromRepo,
  canonicalAliasReaderFromTx,
  createOrRestoreTargetBlock,
  resolveCanonicalAliasOwner,
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

export const JOURNAL_ALIAS = 'Journal'
const JOURNAL_ALIASES = [JOURNAL_ALIAS]

export const journalBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, JOURNAL_NS)

/** Is `data` currently the live claimant of the 'Journal' alias?
 *  `block_aliases_workspace_alias_unique` guarantees at most one live
 *  block holds a given alias per workspace, so this is equivalent to "is
 *  this THE Journal" — true for the canonical `journalBlockId(workspaceId)`
 *  row in the common case, and for an ADOPTED claimant at a different id
 *  after issue #378's alias-first resolution moved the identity there.
 *  Callers that only have `Block.peek()`-shaped data (no tx/repo access —
 *  e.g. the UI deletion guard) use this instead of an id comparison
 *  against `journalBlockId`, which silently stops matching once adoption
 *  happens. */
export const isJournalBlock = (data: Pick<BlockData, 'properties'>): boolean =>
  getAliases(data).includes(JOURNAL_ALIAS)

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

/** The canonical `[longLabel, isoLabel]` alias pair `getOrCreateDailyNote`
 *  claims for `iso`. Exported so callers that need to recognise "is this
 *  block currently the date's daily note" WITHOUT going through
 *  get-or-create (e.g. a raw/tombstone-tolerant read) don't re-derive the
 *  pair themselves — see `isJournalBlock` for the same pattern applied to
 *  the Journal's single alias. */
export const dailyNoteAliasesFor = (iso: string): readonly [string, string] =>
  dailyPageAliases(dailyNoteLocalDate(iso))

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
 *  that logic. Alias-first resolution (issue #378) comes with the
 *  delegation and is not re-stated here: if a live block already owns
 *  'Journal' — the canonical row was deleted and the user then aliased a
 *  different page 'Journal' — `getOrCreateKernelPage` ADOPTS that block
 *  instead of colliding with it on the deterministic id, so the returned
 *  block's id is not always `journalBlockId(workspaceId)`.
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

/** Read-only prediction of the journal's CURRENT resolved id — the
 *  no-tx half of `getOrCreateJournalBlock`'s own alias-first resolution,
 *  used here only to keep the daily note's `needsRepair` comparison
 *  correct once the journal has been ADOPTED at a non-deterministic id
 *  (issue #378). Never authoritative for a write — a write path that
 *  needs the journal to actually exist still calls
 *  `getOrCreateJournalBlock`, which re-resolves fresh inside its own tx. */
const predictedJournalId = async (repo: Repo, workspaceId: string): Promise<string> => {
  const id = journalBlockId(workspaceId)
  const resolved = await resolveCanonicalAliasOwner(
    canonicalAliasReaderFromRepo(repo), JOURNAL_ALIASES, workspaceId, id,
  )
  return resolved.id
}

/** Adoption guard for `getOrCreateDailyNote`'s own alias resolution.
 *  `refuseTypedClaimant`'s plain type-set widening (as used by
 *  `getOrCreateKernelPage`) isn't precise enough here: every daily note
 *  carries `DAILY_NOTE_TYPE`, so unconditionally allowing it would blind
 *  the guard to the exact ambiguity issue #378 names — "a claimant that
 *  is itself a daily note" (for a DIFFERENT day, an extra alias landed on
 *  it by user error). This guard allows `DAILY_NOTE_TYPE` ONLY when the
 *  claimant's own stored date matches `dateValue` — i.e. it's already
 *  THIS day's note (our own prior adoption / repeat resolution, not a
 *  foreign collision). Any OTHER extra type, or a `DAILY_NOTE_TYPE`
 *  claimant for a mismatched (or unreadable) date, is refused. */
const dailyNoteAdoptionGuard = (dateValue: Date): CanonicalAdoptionGuard => claimant => {
  const extraTypes = getBlockTypes(claimant).filter(t => t !== PAGE_TYPE && t !== DAILY_NOTE_TYPE)
  if (extraTypes.length > 0) {
    return `claimant ${claimant.id} already has type(s) ${extraTypes.join(', ')} — ambiguous identity, left unchanged pending an owner decision (issue #378)`
  }
  if (!hasBlockType(claimant, DAILY_NOTE_TYPE)) return null
  let claimantDate: unknown
  try {
    const stored = claimant.properties[dailyNoteDateProp.name]
    claimantDate = stored === undefined ? undefined : dailyNoteDateProp.codec.decode(stored)
  } catch {
    claimantDate = undefined
  }
  const sameDay = claimantDate instanceof Date && claimantDate.getTime() === dateValue.getTime()
  return sameDay
    ? null
    : `claimant ${claimant.id} is itself a daily note for a different date — ambiguous identity, left unchanged pending an owner decision (issue #378)`
}

/** Apply the daily-note's full canonical shape — both aliases (added to,
 *  never replacing, whatever the target already has), `PAGE_TYPE` +
 *  `DAILY_NOTE_TYPE` with the date value, and the journal parent/order —
 *  to the already-live `current` row inside `tx`. Shared by the two
 *  branches that repair/adopt an EXISTING live row
 *  (`getOrCreateDailyNote`'s needsRepair branch and its alias-adoption
 *  branch) so the shape logic lives in one place; the fresh
 *  create/tombstone-restore branch below stays separate since it also
 *  decides content + create-vs-restore.
 *
 *  Takes the row rather than its id so the caller owns the read that
 *  decides liveness — and therefore also owns the workspace check that
 *  belongs beside it. This function `tx.move`s its target under THIS
 *  workspace's journal, so a row from another workspace must never reach
 *  it; see `refuseForeign` at both call sites.
 *
 *  NOT `adoptTypedBlock` (`@/data/typedRecords`), which the kernel-page
 *  adopt path uses for the same-shaped job: that primitive re-tags missing
 *  types and nothing else. A daily note's shape is types PLUS both aliases,
 *  PLUS the `dailyNoteDateProp` value the `DAILY_NOTE_TYPE` tag has to
 *  carry, PLUS the journal parent — and `adoptTypedBlock` passes no initial
 *  values, so routing through it would silently leave a newly-adopted note
 *  with no date and outside the journal. */
const applyDailyNoteShape = async (
  tx: Tx,
  repo: Repo,
  current: BlockData,
  journalId: string,
  orderKey: string,
  dailyAliases: readonly string[],
  dateValue: Date,
  typeSnapshot: TypeRegistrySnapshot,
): Promise<void> => {
  const id = current.id
  const currentAliases = stringListProperty(current.properties[aliasesProp.name])
  if (!includesAll(currentAliases, dailyAliases)) {
    await tx.setProperty(id, aliasesProp, mergeStrings([...dailyAliases, ...currentAliases]))
  }
  await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: dailyAliases}, typeSnapshot)
  await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, {[dailyNoteDateProp.name]: dateValue}, typeSnapshot)
  if (current.parentId !== journalId || current.orderKey !== orderKey) {
    await tx.move(id, {parentId: journalId, orderKey}, {skipMetadata: true})
  }
}

/** Get-or-create today's daily note. Resolves ALIAS-FIRST (issue #378,
 *  repo-owner decision — "try id if not, use alias, everywhere"): a
 *  daily note owns TWO canonical aliases (long-form + ISO), so this
 *  checks both — if a live block already owns either one (e.g. the
 *  canonical row was deleted and the user then aliased a different page
 *  to that date), ADOPT it — apply `PAGE_TYPE` + `DAILY_NOTE_TYPE`,
 *  ensure BOTH aliases, and re-parent under the journal — rather than
 *  minting/restoring at the deterministic id. Adoption mutates the
 *  user's existing block; that's the point of "their page becomes the
 *  daily note". Falls back to the deterministic id when nobody claims
 *  either alias, when the two aliases resolve to two DIFFERENT live
 *  blocks (ambiguous — left unchanged), or when the sole claimant is
 *  refused by `resolveCanonicalAliasOwner`'s guard (already-typed
 *  claimant, e.g. itself a daily note for a different day — also
 *  genuinely ambiguous, left unchanged; see that function's docblock).
 *
 *  Two clients calling concurrently with the same (workspaceId, iso)
 *  write to the same row, so the daily note never duplicates even when
 *  both are offline at boot.
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
  const [longLabel, isoLabel] = dailyNoteAliasesFor(iso)
  const dailyAliases = [longLabel, isoLabel]
  const dateValue = dailyNoteDateValue(iso)
  const guard = dailyNoteAdoptionGuard(dateValue)

  /** Same guard, and the same reasoning, as `getOrCreateKernelPage`'s: the
   *  id-keyed reads below are not workspace-scoped (`repo.load` and `tx.get`
   *  both select on id alone), and what they feed rewrites aliases and types,
   *  resurrects tombstones, and — uniquely here — `tx.move`s the row under
   *  THIS workspace's Journal, which would tear a page out of someone else's
   *  tree.
   *
   *  Worth being honest about reachability, because it differs from the kernel
   *  page's by which half: `DAILY_NOTE_NS` is app-owned and the key already
   *  carries the workspace, so a foreign occupant at rest needs a uuid
   *  collision or a hand-written id. The window between `repo.load` and the
   *  transaction is not hypothetical though — sync materialization rewrites
   *  `workspace_id` along with every other column, so the row can change hands
   *  mid-call whatever the namespace.
   *
   *  Applied to the ALIAS claimant too (issue #378's adoption), even though
   *  `aliasLookup` is workspace-scoped by construction — it selects on
   *  `block_aliases.workspace_id`, which the alias triggers write from
   *  `blocks.workspace_id` and rewrite on `UPDATE OF … workspace_id`. That
   *  makes the check dead code as the index stands today, and it is here
   *  anyway because the write it precedes is the `tx.move`: the cost of being
   *  wrong is a page torn out of another workspace's tree, and the cost of the
   *  check is one comparison. Names `occupant.id` rather than the outer `id`
   *  so it stays truthful on that path (they are the same id on every other). */
  const refuseForeign = (occupant: BlockData): void => {
    if (classifyOccupant(occupant, {workspaceId}).verdict === 'foreign') {
      throw new DeterministicIdCrossWorkspaceError(occupant.id, occupant.workspaceId, workspaceId)
    }
  }

  const predicted = await resolveCanonicalAliasOwner(
    canonicalAliasReaderFromRepo(repo), dailyAliases, workspaceId, id, guard,
  )

  const live = await repo.load(predicted.id)
  if (live) {
    refuseForeign(live)
    const aliases = stringListProperty(live.properties[aliasesProp.name])
    const expectedJournalId = await predictedJournalId(repo, workspaceId)
    const needsRepair =
      live.parentId !== expectedJournalId ||
      live.orderKey !== orderKey ||
      !hasBlockType(live, PAGE_TYPE) ||
      !hasBlockType(live, DAILY_NOTE_TYPE) ||
      !includesAll(aliases, dailyAliases)
    if (!needsRepair) {
      return repo.block(predicted.id)
    }
    const journal = await getOrCreateJournalBlock(repo, workspaceId)
    const typeSnapshot = repo.snapshotTypeRegistries()
    let finalId = predicted.id
    await repo.tx(async tx => {
      // Re-resolve fresh inside the tx — see canonicalAliasReaderFromTx.
      const resolved = await resolveCanonicalAliasOwner(
        canonicalAliasReaderFromTx(tx), dailyAliases, workspaceId, id, guard,
      )
      finalId = resolved.id
      const current = await tx.get(resolved.id)
      if (!current || current.deleted) return
      refuseForeign(current)
      await applyDailyNoteShape(
        tx, repo, current, journal.id, orderKey, dailyAliases, dateValue, typeSnapshot,
      )
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(finalId)
  }

  const journal = await getOrCreateJournalBlock(repo, workspaceId)

  const typeSnapshot = repo.snapshotTypeRegistries()
  let finalId = id
  await repo.tx(async tx => {
    const resolved = await resolveCanonicalAliasOwner(
      canonicalAliasReaderFromTx(tx), dailyAliases, workspaceId, id, guard,
    )
    if (resolved.adopted) {
      // A live block already owns the long-form or ISO alias — adopt it
      // instead of minting/restoring the deterministic id (issue #378).
      // Ensures whichever of the two aliases it didn't already have.
      // `resolved.claimant` is the row the in-tx `aliasLookup` returned, so it
      // is live in this transaction by construction — no second read.
      refuseForeign(resolved.claimant)
      finalId = resolved.id
      await applyDailyNoteShape(
        tx, repo, resolved.claimant, journal.id, orderKey, dailyAliases, dateValue, typeSnapshot,
      )
      return
    }
    finalId = id
    const existing = await tx.get(id)
    if (existing) refuseForeign(existing)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      // The tombstone's stored alias bag can hold an EXTRA entry a
      // different live block claimed while the daily note was dead — as
      // opposed to the CANONICAL long-form/ISO aliases themselves,
      // handled above via `resolved.adopted`. Restoring the bag as-is
      // would re-insert that stale extra claim and abort the whole tx.
      // Strip it here; the setProperty below re-claims exactly the
      // canonical long-form + ISO aliases.
      const restoredProperties = await restorePropertiesStrippingAliases(tx, id)
      await tx.restore(id, {content: longLabel, properties: restoredProperties})
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

  return repo.block(finalId)
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
