import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { parseRelativeDate } from '@/utils/relativeDate.js'
import { dailyNoteBlockId } from '@/plugins/daily-notes/dailyNotes.js'
import { clipLine, oneLine } from './text.ts'

/** How an agent names a block, in the order they are tried:
 *  - `((id))` / `^id` — explicitly an id, the second as the views print one;
 *  - `[[Name]]` — explicitly a page name (exact alias);
 *  - a bare string: an existing id, a UUID, an exact alias, then a date
 *    expression (today, 2026-06-18, "next monday") naming its daily note.
 *
 *  Alias before date, so a page literally named "Today" wins over the date —
 *  the same answer `[[Today]]` gives in content. */
export type BlockRefVia = 'id' | 'alias' | 'date' | 'verbatim'

export type BlockRefResolution =
  | {id: string; via: Exclude<BlockRefVia, 'date'>}
  /** `iso` is the day the date expression read as — reuse it, never re-parse:
   *  a relative one can read as another day a moment later. */
  | {id: string; via: 'date'; iso: string}

export interface ResolveBlockRefOptions {
  workspaceId: string | null
  /** `verbatim` hands an unmatched ref back unchanged, for raw commands whose
   *  missing-block answer (`null`, a not-found error) is part of their shape. */
  onMissing?: 'error' | 'verbatim'
  /** `id` admits only an id — for a target a write modifies or
   *  destroys, where resolving a name or a date is one typo from the wrong block. */
  accept?: 'any' | 'id'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Its message reaches an agent verbatim through the CLI and MCP, so every
 *  piece of user text in it (the ref, candidate aliases) is
 *  neutralized like any other display text. */
export class BlockRefError extends Error {
  constructor(message: string, readonly candidates: readonly string[] = []) {
    super(message)
    this.name = 'BlockRefError'
  }
}

const EXISTS_SQL = 'SELECT 1 AS one FROM blocks WHERE id = ?'

const unwrap = (ref: string): {text: string, forced?: 'id' | 'alias'} => {
  const trimmed = ref.trim()
  const blockRef = trimmed.match(/^\(\((.+)\)\)$/)
  if (blockRef) return {text: blockRef[1].trim(), forced: 'id'}
  const pageRef = trimmed.match(/^\[\[(.+)\]\]$/)
  if (pageRef) return {text: pageRef[1].trim(), forced: 'alias'}
  if (trimmed.startsWith('^')) return {text: trimmed.slice(1), forced: 'id'}
  return {text: trimmed}
}

const resolveIdLike = async (
  repo: Repo,
  text: string,
): Promise<BlockRefResolution | null> => {
  // Verbatim: sync and restore admit non-canonical (mixed-case) ids, and
  // lowercasing one would read a different row, or none.
  if (UUID_RE.test(text)) return {id: text, via: 'id'}
  const exists = await repo.db.getOptional(EXISTS_SQL, [text])
  return exists ? {id: text, via: 'id'} : null
}

const resolveName = async (
  repo: Repo,
  text: string,
  workspaceId: string,
): Promise<BlockRefResolution | null> => {
  const page = await repo.query.aliasLookup({workspaceId, alias: text}).load() as BlockData | null
  if (page) return {id: page.id, via: 'alias'}
  return null
}

const resolveDate = (text: string, workspaceId: string): BlockRefResolution | null => {
  const parsed = parseRelativeDate(text)
  return parsed ? {id: dailyNoteBlockId(workspaceId, parsed.iso), via: 'date', iso: parsed.iso} : null
}

const notFound = async (
  repo: Repo,
  ref: string,
  text: string,
  workspaceId: string | null,
): Promise<BlockRefError> => {
  const candidates = workspaceId && text
    ? await repo.query.aliasMatches({workspaceId, filter: text, limit: 5}).load()
    : []
  const hint = candidates.length > 0
    ? `\nPages with similar names:\n${candidates.map(row => `  ${clipLine(row.alias, 80).text}`).join('\n')}`
    : ''
  return new BlockRefError(
    `No block matches "${oneLine(ref)}" (tried: id, page name, date).${hint}`,
    candidates.map(row => row.blockId),
  )
}

/** Resolve an agent-supplied block reference to a block id. See
 *  {@link BlockRefVia} for the accepted forms and their order. */
export const resolveBlockRef = async (
  repo: Repo,
  ref: string,
  {workspaceId, onMissing = 'error', accept = 'any'}: ResolveBlockRefOptions,
): Promise<BlockRefResolution> => {
  // Unwrapped before any exact-id probe: a synced row planted with the id `[[Inbox]]`
  // must not capture refs to the real page. Such an id is reached as `((id))`.
  const {text, forced} = unwrap(ref)
  if (!text) throw new BlockRefError('A block reference is required.')

  const namesAllowed = accept === 'any' && workspaceId !== null
  if (forced !== 'alias') {
    const idLike = await resolveIdLike(repo, text)
    if (idLike) return idLike
  }
  if (namesAllowed && forced !== 'id') {
    const named = await resolveName(repo, text, workspaceId)
      ?? (forced === undefined ? resolveDate(text, workspaceId) : null)
    if (named) return named
  }

  if (onMissing === 'verbatim') return {id: ref, via: 'verbatim'}
  if (accept === 'id') {
    throw new BlockRefError(`No block has id "${oneLine(ref)}". This operation takes a block id, not a name.`)
  }
  throw await notFound(repo, ref, text, workspaceId)
}
