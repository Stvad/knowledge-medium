/**
 * Write targets for agent-bridge verbs: `resolveBlockRef` (the read views'
 * resolver — ids, `^short` prefixes, page names, dates) plus what only a write
 * needs, CREATING a missing page or daily note:
 *   - `[[Name]]` — found by alias exactly as a wikilink is; on a miss created
 *     the way a wikilink creates it (a date-literal name is that day's daily
 *     note).
 *   - a date expression (`today`, `2026-10-15`, `next monday`) — that day's
 *     daily note, created if missing (see {@link isExplicitDate}).
 * A bare name that matches nothing is refused rather than created, so a typo'd
 * id or name never mints a page — creating one takes the explicit `[[…]]`.
 */
import { pageNameInTarget } from '@knowledge-medium/agent-cli/protocol'
import type { Repo } from '@/data/repo'
import type { InsertPosition } from '@/data/mutators.js'
import { assertRoundTrippableReferenceLabel } from '@/data/referenceBlock.js'
import { ensureAliasTarget } from '@/data/targets.js'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle, parseRelativeDate } from '@/utils/relativeDate.js'
import { agentTxOptions } from './agentWrites.ts'
import { BlockRefError, resolveBlockRef, type BlockRefResolution } from './agentViews/resolveRef.ts'
import { assertActiveWorkspace } from './workspaceGuard.ts'

type ParsedAgentTarget =
  | {kind: 'page'; name: string}
  | {kind: 'block'; ref: string}
  /** An id, an id prefix, a page name or a date expression. */
  | {kind: 'bare'; text: string}

const wrapped = (raw: string, open: string, close: string): string | null =>
  raw.startsWith(open) && raw.endsWith(close) && raw.length >= open.length + close.length
    ? raw.slice(open.length, raw.length - close.length).trim()
    : null

export const parseAgentTarget = (raw: string): ParsedAgentTarget => {
  const text = raw.trim()
  if (text === '') throw new Error('Target is empty. Pass a block id, a [[Page]], or a date.')
  const page = pageNameInTarget(text)
  if (page !== null) {
    if (page === '') throw new Error('Target [[ ]] is empty — put the page name inside the brackets.')
    return {kind: 'page', name: page}
  }
  const ref = wrapped(text, '((', '))') ?? (text.startsWith('^') ? text.slice(1).trim() : null)
  if (ref !== null) {
    if (ref === '') throw new Error(`Target ${text} names no block — put the block id in it.`)
    return {kind: 'block', ref}
  }
  return {kind: 'bare', text}
}

type ResolvedTargetKind = 'block' | 'page' | 'daily'

export interface ResolvedAgentTarget {
  id: string
  kind: ResolvedTargetKind
  /** This call created the page / daily note. */
  created: boolean
}

interface ResolveTargetOptions {
  /** Create a missing page / daily note (default). Off for an anchored
   *  insert: the anchor's parent already exists, so a miss is the caller's
   *  error and must not leave a new empty page behind. */
  create?: boolean
  /** The workspace the call was pinned to; read once, so a switch later in
   *  the call is refused rather than silently re-pinned. */
  workspaceId?: string
}

const activeWorkspace = (repo: Repo, verb: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error(`${verb}: no active workspace — open one in the app and retry.`)
  return workspaceId
}

/** A block id for an id-typed field (`id`, `siblingId`): an id or a unique id
 *  prefix, never a name or a date — one typo from the wrong block. A ref that
 *  matches nothing comes back as the id it names, so the verb reports its own
 *  not-found. */
export const resolveBlockId = async (repo: Repo, raw: string, verb: string): Promise<string> => {
  const resolved = await resolveBlockRef(repo, raw, {
    // Only names and dates are workspace-scoped, and `accept: 'id'` rules both out.
    workspaceId: null,
    onMissing: 'verbatim',
    accept: 'id',
  })
  if (resolved.via !== 'verbatim') return resolved.id
  // Nothing matched. The ref's syntax still decides what it named, even beside
  // a synced row whose id is literally the wrapper (reached as `((…))`): a
  // `[[x]]` is a page, never an id; `((x))` / `^x` name the missing id `x`.
  const target = parseAgentTarget(raw)
  if (target.kind === 'page') throw new Error(`${verb}: expected a block id, got the page target ${raw.trim()}.`)
  return target.kind === 'block' ? target.ref : resolved.id
}

/** An id field as the verb acts on it. `exact` is the caller saying the value
 *  is already a stored id — km-mcp resolves before its write guard and sends
 *  that, so the guard and the write cannot pick different blocks; it is also
 *  the one lossless spelling of an odd stored id (a ref is trimmed and read
 *  as syntax). Otherwise {@link resolveBlockId}. */
export const blockIdField = (repo: Repo, raw: string, verb: string, exact = false): Promise<string> =>
  exact ? Promise.resolve(raw) : resolveBlockId(repo, raw, verb)

/** A first / last / before / after position, its sibling id resolved as an
 *  id field (see {@link blockIdField}). */
export const blockPositionField = async (
  repo: Repo,
  position: InsertPosition,
  verb: string,
  exact = false,
): Promise<InsertPosition> =>
  position.kind === 'before' || position.kind === 'after'
    ? {kind: position.kind, siblingId: await blockIdField(repo, position.siblingId, verb, exact)}
    : position

/** The daily note for an ISO date in the active workspace, created if missing.
 *  `verb` names the caller in errors and attributes a page it creates. */
export const resolveDailyNoteTarget = async (
  repo: Repo,
  iso: string,
  verb: string,
  {create = true, workspaceId = activeWorkspace(repo, verb)}: ResolveTargetOptions = {},
): Promise<ResolvedAgentTarget> => {
  // `created` is read before the write: a note another device creates in the
  // same instant reports as created here (informational; accepted).
  const existed = (await repo.load(dailyNoteBlockId(workspaceId, iso))) !== null
  if (!existed && !create) throw new Error(`${verb}: the daily note for ${iso} does not exist yet.`)
  // Its txs write through the ACTIVE workspace's registries. The residual — a
  // switch inside the call — is shared with every UI caller of it.
  assertActiveWorkspace(repo, verb, workspaceId)
  // Even for an existing row: get-or-create also promotes the seat a
  // `[[date]]` wikilink mints at workspace root into the Journal's note.
  const note = await getOrCreateDailyNote(repo, workspaceId, iso, agentTxOptions(verb))
  return {id: note.id, kind: 'daily', created: !existed}
}

/** A page by name, exactly as `[[name]]` resolves and creates it (see the
 *  module header). */
export const resolvePageTarget = async (
  repo: Repo,
  name: string,
  verb: string,
  options: ResolveTargetOptions = {},
): Promise<ResolvedAgentTarget> => {
  const workspaceId = options.workspaceId ?? activeWorkspace(repo, verb)
  const pinned = {...options, workspaceId}
  const existing = await repo.query.aliasLookup({workspaceId, alias: name}).load()
  const date = parseLiteralDailyPageTitle(name)
  // A date-literal name is that day's note — unless a different page claims
  // the name, which is what a wikilink binds to.
  if (date && (!existing || existing.id === dailyNoteBlockId(workspaceId, date.iso))) {
    return resolveDailyNoteTarget(repo, date.iso, verb, pinned)
  }
  if (existing) {
    // Nothing after this re-checks a page that already exists (create-page
    // returns it as is), so a switch during the lookup is refused here.
    assertActiveWorkspace(repo, verb, workspaceId)
    return {id: existing.id, kind: 'page', created: false}
  }
  if (options.create === false) throw new Error(`${verb}: no page named [[${name}]].`)
  // Typing a link no parser reads as one creates nothing; neither does this.
  assertRoundTrippableReferenceLabel(name, `${verb}: page name`)
  let result: {id: string; inserted: boolean} | undefined
  await repo.tx(async tx => {
    // The seat is minted through the ACTIVE workspace's type registry.
    assertActiveWorkspace(repo, verb, workspaceId)
    result = await ensureAliasTarget(tx, repo, name, workspaceId)
  }, agentTxOptions(verb))
  return {id: result!.id, kind: 'page', created: result!.inserted}
}

const EXPLICIT_RELATIVE_DATE =
  /^(?:today|yesterday|tomorrow|(?:next|last|this) (?:mon|tues|wednes|thurs|fri|satur|sun)day)$/i

/** A date a bare target may CREATE a daily note for: a literal one (2026-10-15,
 *  "October 15th, 2026") or a plain relative day. Other text chrono reads as a
 *  date ("May", "weekend", a page name in the wrong case) only finds an
 *  existing note, so a typo never mints one. */
const isExplicitDate = (text: string): boolean =>
  EXPLICIT_RELATIVE_DATE.test(text) || parseLiteralDailyPageTitle(text) !== null

/** A block target must be a live block in the workspace the call was pinned
 *  to, still active. A UUID-shaped ref resolves without a lookup, so this is
 *  where a missing one is caught — before the write pays for its payload. The
 *  writing tx checks again; this is the early refusal, not the authoritative
 *  one. */
const liveBlockTarget = async (
  repo: Repo,
  id: string,
  verb: string,
  workspaceId: string,
): Promise<ResolvedAgentTarget> => {
  const row = await repo.db.getOptional<{deleted: number, workspace_id: string}>(
    'SELECT deleted, workspace_id FROM blocks WHERE id = ?', [id],
  )
  if (!row) throw new Error(`${verb}: block ${id} not found.`)
  if (row.deleted) throw new Error(`${verb}: block ${id} is deleted — restore it first, or write elsewhere.`)
  assertActiveWorkspace(repo, verb, row.workspace_id)
  if (row.workspace_id !== workspaceId) {
    throw new Error(
      `${verb}: the active workspace changed from ${workspaceId} to ${row.workspace_id} while resolving this `
      + 'command\'s target.',
    )
  }
  return {id, kind: 'block', created: false}
}

/** An insert anchor must be a live child of the target. The early refusal,
 *  before a write pays for its payload; the writing tx places the run next to
 *  the anchor and refuses again if it moved. */
export const assertAnchorUnder = async (
  repo: Repo,
  position: InsertPosition,
  parentId: string,
  verb: string,
): Promise<void> => {
  if (position.kind !== 'before' && position.kind !== 'after') return
  const row = await repo.db.getOptional<{parent_id: string | null; deleted: number}>(
    'SELECT parent_id, deleted FROM blocks WHERE id = ?', [position.siblingId],
  )
  if (!row || row.deleted || row.parent_id !== parentId) {
    throw new Error(`${verb}: the ${position.kind} anchor ${position.siblingId} is not a live child of block ${parentId}.`)
  }
}

/** Resolve any target, creating a missing page / daily note. That creation
 *  commits before the caller's own write; run both under one `repo.undoGroup`
 *  facade (pass it as `repo`) so they undo together. A ref is trimmed before
 *  any lookup, so an id differing from another only by surrounding whitespace
 *  (non-canonical; only sync can carry one) is not reachable as a target —
 *  accepted rather than given a target syntax of its own. */
export const resolveAgentTarget = async (
  repo: Repo,
  raw: string,
  verb: string,
  options: ResolveTargetOptions = {},
): Promise<ResolvedAgentTarget> => {
  const target = parseAgentTarget(raw)
  const pinned = {...options, workspaceId: options.workspaceId ?? activeWorkspace(repo, verb)}
  if (target.kind === 'page') return resolvePageTarget(repo, target.name, verb, pinned)
  let found: BlockRefResolution
  try {
    found = await resolveBlockRef(repo, raw, {workspaceId: pinned.workspaceId})
  } catch (error) {
    if (!(error instanceof BlockRefError)) throw error
    const hint = target.kind === 'bare' ? ` To create a page by that name, pass [[${target.text}]].` : ''
    throw new Error(`${verb}: ${error.message}${hint}`, {cause: error})
  }
  if (found.via === 'id' || found.via === 'prefix') return liveBlockTarget(repo, found.id, verb, pinned.workspaceId)
  if (found.via === 'date') {
    // `resolveBlockRef` names the day's deterministic id; the note itself may
    // not exist yet.
    const text = raw.trim()
    const {iso} = parseRelativeDate(text)!
    if (!isExplicitDate(text) && (await repo.load(dailyNoteBlockId(pinned.workspaceId, iso))) === null) {
      throw new Error(
        `${verb}: "${text}" reads as the date ${iso}, whose daily note does not exist — pass ${iso} to create it, `
        + `or [[${text}]] for a page.`,
      )
    }
    return resolveDailyNoteTarget(repo, iso, verb, pinned)
  }
  // A bare name that resolved through an alias: if the alias is gone by this
  // second lookup, bare text still creates nothing.
  return resolvePageTarget(repo, raw.trim(), verb, {...pinned, create: false})
}
