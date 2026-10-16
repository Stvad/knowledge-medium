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
import type { Repo } from '@/data/repo'
import { ensureAliasTarget } from '@/data/targets.js'
import { dailyNoteBlockId, getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle, parseRelativeDate } from '@/utils/relativeDate.js'
import { agentTxOptions } from './agentWrites.ts'
import { BlockRefError, resolveBlockRef } from './agentViews/resolveRef.ts'
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
  const page = wrapped(text, '[[', ']]')
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

const activeWorkspace = (repo: Repo, verb: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error(`${verb}: no active workspace — open one in the app and retry.`)
  return workspaceId
}

/** A block id for an id-typed field (`id`, `siblingId`): an id or a unique id
 *  prefix, never a name or a date — one typo from the wrong block. A ref that
 *  matches nothing comes back as given, so the verb reports its own not-found. */
export const resolveBlockId = async (repo: Repo, raw: string, verb: string): Promise<string> => {
  if (parseAgentTarget(raw).kind === 'page') {
    throw new Error(`${verb}: expected a block id, got the page target ${raw.trim()}.`)
  }
  const resolved = await resolveBlockRef(repo, raw, {
    // Only names and dates are workspace-scoped, and `accept: 'id'` rules both out.
    workspaceId: null,
    onMissing: 'verbatim',
    accept: 'id',
  })
  return resolved.id
}

/** The daily note for an ISO date in the active workspace, created if missing.
 *  `verb` names the caller in errors and attributes a page it creates. */
export const resolveDailyNoteTarget = async (
  repo: Repo,
  iso: string,
  verb: string,
): Promise<ResolvedAgentTarget> => {
  const workspaceId = activeWorkspace(repo, verb)
  const id = dailyNoteBlockId(workspaceId, iso)
  if (await repo.load(id)) return {id, kind: 'daily', created: false}
  const note = await getOrCreateDailyNote(repo, workspaceId, iso)
  return {id: note.id, kind: 'daily', created: true}
}

/** A page found by name is labelled `daily` when it is that date's note. */
const namedKind = (workspaceId: string, name: string, id: string): ResolvedTargetKind => {
  const date = parseLiteralDailyPageTitle(name)
  return date && dailyNoteBlockId(workspaceId, date.iso) === id ? 'daily' : 'page'
}

/** A page by name, exactly as `[[name]]` resolves and creates it (see the
 *  module header). */
export const resolvePageTarget = async (
  repo: Repo,
  name: string,
  verb: string,
): Promise<ResolvedAgentTarget> => {
  const workspaceId = activeWorkspace(repo, verb)
  const existing = await repo.query.aliasLookup({workspaceId, alias: name}).load()
  if (existing) return {id: existing.id, kind: namedKind(workspaceId, name, existing.id), created: false}
  const date = parseLiteralDailyPageTitle(name)
  if (date) return resolveDailyNoteTarget(repo, date.iso, verb)
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
): Promise<ResolvedAgentTarget> => {
  const target = parseAgentTarget(raw)
  if (target.kind === 'page') return resolvePageTarget(repo, target.name, verb)
  const workspaceId = activeWorkspace(repo, verb)
  let found
  try {
    found = await resolveBlockRef(repo, raw, {workspaceId})
  } catch (error) {
    if (!(error instanceof BlockRefError)) throw error
    const hint = target.kind === 'bare' ? ` To create a page by that name, pass [[${target.text}]].` : ''
    throw new Error(`${verb}: ${error.message}${hint}`, {cause: error})
  }
  switch (found.via) {
    case 'alias':
      return {id: found.id, kind: namedKind(workspaceId, raw.trim(), found.id), created: false}
    case 'date':
      // `resolveBlockRef` names the day's deterministic id; the note itself may
      // not exist yet.
      return resolveDailyNoteTarget(repo, parseRelativeDate(raw)!.iso, verb)
    default:
      return {id: found.id, kind: 'block', created: false}
  }
}
