/**
 * Write targets for agent-bridge verbs: `resolveBlockRef` (the read views'
 * resolver — ids, `^short` prefixes, page names, dates) plus what only a write
 * needs, CREATING a missing page or daily note:
 *   - `[[Name]]` — found by alias exactly as a wikilink is; on a miss created
 *     the way a wikilink creates it (a date-literal name is that day's daily
 *     note).
 *   - a date expression (`today`, `2026-10-15`, `next monday`) — that day's
 *     daily note, created if missing.
 * A bare name that matches nothing is refused rather than created, so a typo'd
 * id or name never mints a page — creating one takes the explicit `[[…]]`.
 */
import { pageNameInTarget } from '@knowledge-medium/agent-cli/protocol'
import type { Repo } from '@/data/repo'
import { ensureAliasTarget } from '@/data/targets.js'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle, parseRelativeDate } from '@/utils/relativeDate.js'
import { agentTxOptions } from './agentWrites.ts'
import { BlockRefError, resolveBlockRef, type BlockRefResolution } from './agentViews/resolveRef.ts'
import { assertActiveWorkspace } from './workspaceGuard.ts'

export type ParsedAgentTarget =
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

export type ResolvedTargetKind = 'block' | 'page' | 'daily'

export interface ResolvedAgentTarget {
  id: string
  kind: ResolvedTargetKind
  /** This call created the page / daily note. */
  created: boolean
}

export interface ResolveTargetOptions {
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
 *  matches nothing comes back as given, so the verb reports its own not-found. */
export const resolveBlockId = async (repo: Repo, raw: string, verb: string): Promise<string> => {
  const resolved = await resolveBlockRef(repo, raw, {
    // Only names and dates are workspace-scoped, and `accept: 'id'` rules both out.
    workspaceId: null,
    onMissing: 'verbatim',
    accept: 'id',
  })
  // After the lookup: a stored id may itself look like `[[x]]`.
  if (resolved.via === 'verbatim' && parseAgentTarget(raw).kind === 'page') {
    throw new Error(`${verb}: expected a block id, got the page target ${raw.trim()}.`)
  }
  return resolved.id
}

/** The daily note for an ISO date in the active workspace, created if missing.
 *  `verb` names the caller in errors and attributes a page it creates. */
export const resolveDailyNoteTarget = async (
  repo: Repo,
  iso: string,
  verb: string,
  {create = true, workspaceId = activeWorkspace(repo, verb)}: ResolveTargetOptions = {},
): Promise<ResolvedAgentTarget> => {
  const existed = (await repo.load(dailyNoteBlockId(workspaceId, iso))) !== null
  if (!existed && !create) throw new Error(`${verb}: the daily note for ${iso} does not exist yet.`)
  // Its txs write through the ACTIVE workspace's registries. The residual — a
  // switch inside the call — is shared with every UI caller of it.
  assertActiveWorkspace(repo, verb, workspaceId)
  // Even for an existing row: get-or-create also promotes the seat a
  // `[[date]]` wikilink mints at workspace root into the Journal's note.
  const note = await getOrCreateDailyNote(repo, workspaceId, iso)
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
  if (existing) return {id: existing.id, kind: 'page', created: false}
  if (options.create === false) throw new Error(`${verb}: no page named [[${name}]].`)
  let result: {id: string; inserted: boolean} | undefined
  await repo.tx(async tx => {
    // The seat is minted through the ACTIVE workspace's type registry.
    assertActiveWorkspace(repo, verb, workspaceId)
    result = await ensureAliasTarget(tx, repo, name, workspaceId)
  }, agentTxOptions(verb))
  return {id: result!.id, kind: 'page', created: result!.inserted}
}

/** Resolve any target, creating a missing page / daily note. That creation
 *  commits before the caller's own write; run both under one `repo.undoGroup`
 *  facade (pass it as `repo`) so they undo together. */
export const resolveAgentTarget = async (
  repo: Repo,
  raw: string,
  verb: string,
  options: ResolveTargetOptions = {},
): Promise<ResolvedAgentTarget> => {
  const target = parseAgentTarget(raw)
  const pinned = {...options, workspaceId: options.workspaceId ?? activeWorkspace(repo, verb)}
  let found: BlockRefResolution | null = null
  try {
    found = await resolveBlockRef(repo, raw, {workspaceId: pinned.workspaceId})
  } catch (error) {
    if (!(error instanceof BlockRefError)) throw error
    // A missing [[page]] is created below; any other miss is the caller's.
    if (target.kind !== 'page') {
      const hint = target.kind === 'bare' ? ` To create a page by that name, pass [[${target.text}]].` : ''
      throw new Error(`${verb}: ${error.message}${hint}`, {cause: error})
    }
  }
  // An id first — a stored id may itself look like `[[x]]`.
  if (found?.via === 'id' || found?.via === 'prefix') return {id: found.id, kind: 'block', created: false}
  if (target.kind === 'page') return resolvePageTarget(repo, target.name, verb, pinned)
  if (found?.via === 'date') {
    // `resolveBlockRef` names the day's deterministic id; the note itself may
    // not exist yet.
    return resolveDailyNoteTarget(repo, parseRelativeDate(raw)!.iso, verb, pinned)
  }
  return resolvePageTarget(repo, raw.trim(), verb, pinned)
}
