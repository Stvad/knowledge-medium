/**
 * Target resolution for agent-bridge verbs: the one place a string an agent
 * typed becomes a block id.
 *
 * Grammar (also stated in the km MCP tool descriptions):
 *   - `((ref))` or a bare ref — a block: its exact id, else a unique prefix of
 *     at least {@link MIN_ID_PREFIX_LENGTH} hex digits (the short ids outlines
 *     print).
 *   - `[[Name]]` — a page, found by alias exactly as a wikilink is; on a miss
 *     it is created the way a wikilink creates it (a date-literal name is that
 *     day's daily note).
 *   - a bare date expression (`today`, `2026-10-15`, `next monday`) — that
 *     day's daily note.
 * A bare string that is none of these is refused rather than read as a page
 * name, because a page target can CREATE: a typo'd id must not mint a page.
 */
import type { Repo } from '@/data/repo'
import { ensureAliasTarget } from '@/data/targets.js'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle, parseRelativeDate } from '@/utils/relativeDate.js'
import { agentTxOptions } from './agentWrites.ts'
import { assertActiveWorkspace } from './workspaceGuard.ts'

export const MIN_ID_PREFIX_LENGTH = 8

export type ParsedAgentTarget =
  | {kind: 'page'; name: string}
  | {kind: 'block'; ref: string}
  /** An id, an id prefix, or a date expression — decided against the data. */
  | {kind: 'bare'; text: string}

const wrapped = (raw: string, open: string, close: string): string | null =>
  raw.startsWith(open) && raw.endsWith(close) && raw.length >= open.length + close.length
    ? raw.slice(open.length, raw.length - close.length).trim()
    : null

export const parseAgentTarget = (raw: string): ParsedAgentTarget => {
  const text = raw.trim()
  if (text === '') throw new Error('Target is empty. Pass a block id, a [[Page]], or a date.')
  const page = wrapped(text, '[[', ']]')
  if (page !== null) {
    if (page === '') throw new Error('Target [[ ]] is empty — put the page name inside the brackets.')
    return {kind: 'page', name: page}
  }
  const ref = wrapped(text, '((', '))')
  if (ref !== null) {
    if (ref === '') throw new Error('Target (( )) is empty — put the block id inside the parentheses.')
    return {kind: 'block', ref}
  }
  return {kind: 'bare', text}
}

export type ResolvedTargetKind = 'block' | 'page' | 'daily'

export interface ResolvedAgentTarget {
  id: string
  workspaceId: string
  kind: ResolvedTargetKind
  /** This call created the page / daily note. */
  created: boolean
}

export interface ResolveTargetOptions {
  /** Create a missing page / daily note. Block refs never create. */
  create?: boolean
  /** The verb, for error messages and the attribution of a page it creates. */
  verb: string
}

const ID_PREFIX_RE = new RegExp(`^[0-9a-f]{${MIN_ID_PREFIX_LENGTH},}(?:-[0-9a-f-]*)?$`)

const activeWorkspace = (repo: Repo, verb: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error(`${verb}: no active workspace — open one in the app and retry.`)
  return workspaceId
}

/** Exact id first, in any workspace and including tombstones: the verb decides
 *  what a deleted or foreign block means for it, and its own error says so. */
const exactBlock = async (repo: Repo, id: string): Promise<{id: string; workspaceId: string} | null> =>
  repo.db.getOptional<{id: string; workspaceId: string}>(
    'SELECT id, workspace_id AS workspaceId FROM blocks WHERE id = ?',
    [id],
  )

/** Ids in the active workspace starting with `prefix`, tombstones included, so
 *  a prefix that also names a deleted block is ambiguous instead of silently
 *  meaning the live one. */
const blocksByPrefix = async (
  repo: Repo,
  workspaceId: string,
  prefix: string,
): Promise<Array<{id: string; content: string; deleted: number}>> =>
  repo.db.getAll(
    `SELECT id, content, deleted FROM blocks
      WHERE workspace_id = ? AND id >= ? AND id < ?
      ORDER BY id LIMIT 6`,
    // Ids are lowercase hex and '-', all below 'g'.
    [workspaceId, prefix, `${prefix}g`],
  )

const snippet = (content: string): string => {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

/** Resolve a block ref (`((ref))` or bare): exact id, else unique id prefix.
 *  Returns null when the text is not prefix-shaped and names no block, so a
 *  caller with a date fallback can try that next. */
const resolveBlockRef = async (
  repo: Repo,
  ref: string,
  verb: string,
): Promise<{id: string; workspaceId: string} | null> => {
  const exact = await exactBlock(repo, ref)
  if (exact) return exact
  const prefix = ref.toLowerCase()
  if (!ID_PREFIX_RE.test(prefix)) return null
  const workspaceId = activeWorkspace(repo, verb)
  const matches = await blocksByPrefix(repo, workspaceId, prefix)
  if (matches.length === 1) return {id: matches[0].id, workspaceId}
  if (matches.length === 0) return null
  const listed = matches.slice(0, 5).map(match =>
    `${match.id}${match.deleted ? ' (deleted)' : ''} "${snippet(match.content)}"`,
  )
  throw new Error(
    `${verb}: id prefix "${ref}" is ambiguous — it matches ${listed.join(', ')}`
    + `${matches.length > 5 ? ', …' : ''}. Pass more of the id.`,
  )
}

const notABlock = (verb: string, ref: string): Error =>
  new Error(`${verb}: no block with id or id prefix "${ref}".`)

/** A block id for an id-typed field (`id`, `siblingId`): `((ref))` or a bare
 *  ref, a short id expanded to the full one. A ref that names no block comes
 *  back as given, so the verb still reports its own not-found. Pages and dates
 *  are refused — an id field never creates. */
export const resolveBlockId = async (repo: Repo, raw: string, verb: string): Promise<string> => {
  const target = parseAgentTarget(raw)
  if (target.kind === 'page') {
    throw new Error(`${verb}: expected a block id, got the page target ${raw.trim()}.`)
  }
  const ref = target.kind === 'block' ? target.ref : target.text
  return (await resolveBlockRef(repo, ref, verb))?.id ?? ref
}

const resolveDaily = async (
  repo: Repo,
  workspaceId: string,
  iso: string,
  {create = false, verb}: ResolveTargetOptions,
): Promise<ResolvedAgentTarget> => {
  const id = dailyNoteBlockId(workspaceId, iso)
  const existing = await repo.load(id)
  if (existing) return {id, workspaceId, kind: 'daily', created: false}
  if (!create) throw new Error(`${verb}: the daily note for ${iso} does not exist yet.`)
  const note = await getOrCreateDailyNote(repo, workspaceId, iso)
  return {id: note.id, workspaceId, kind: 'daily', created: true}
}

const resolvePage = async (
  repo: Repo,
  workspaceId: string,
  name: string,
  options: ResolveTargetOptions,
): Promise<ResolvedAgentTarget> => {
  const existing = await repo.query.aliasLookup({workspaceId, alias: name}).load()
  if (existing) return {id: existing.id, workspaceId, kind: 'page', created: false}
  const date = parseLiteralDailyPageTitle(name)
  if (date) return resolveDaily(repo, workspaceId, date.iso, options)
  if (!options.create) throw new Error(`${options.verb}: no page named [[${name}]].`)
  let result: {id: string; inserted: boolean} | undefined
  await repo.tx(async tx => {
    assertActiveWorkspace(repo, options.verb, workspaceId)
    result = await ensureAliasTarget(tx, repo, name, workspaceId)
  }, agentTxOptions(options.verb))
  return {id: result!.id, workspaceId, kind: 'page', created: result!.inserted}
}

/** A page by name, exactly as `[[name]]` resolves (see the module header). */
export const resolvePageTarget = (
  repo: Repo,
  name: string,
  options: ResolveTargetOptions,
): Promise<ResolvedAgentTarget> =>
  resolvePage(repo, activeWorkspace(repo, options.verb), name, options)

/** The daily note for an ISO date in the active workspace. */
export const resolveDailyNoteTarget = (
  repo: Repo,
  iso: string,
  options: ResolveTargetOptions,
): Promise<ResolvedAgentTarget> =>
  resolveDaily(repo, activeWorkspace(repo, options.verb), iso, options)

/** Resolve any target. Creating a page or daily note commits before the
 *  caller's own write; run both under one `repo.undoGroup` facade (pass it as
 *  `repo`) so they undo together. */
export const resolveAgentTarget = async (
  repo: Repo,
  raw: string,
  options: ResolveTargetOptions,
): Promise<ResolvedAgentTarget> => {
  const target = parseAgentTarget(raw)
  if (target.kind === 'page') return resolvePageTarget(repo, target.name, options)
  const ref = target.kind === 'block' ? target.ref : target.text
  const block = await resolveBlockRef(repo, ref, options.verb)
  if (block) return {...block, kind: 'block', created: false}
  if (target.kind === 'bare') {
    const date = parseRelativeDate(ref)
    if (date) return resolveDailyNoteTarget(repo, date.iso, options)
    if (!ID_PREFIX_RE.test(ref.toLowerCase())) {
      throw new Error(
        `${options.verb}: "${ref}" is not a block id, a [[Page]] or a date. `
        + `For a page, wrap its name: [[${ref}]].`,
      )
    }
  }
  throw notABlock(options.verb, ref)
}
