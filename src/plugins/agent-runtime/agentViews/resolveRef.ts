import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { parseRelativeDate } from '@/utils/relativeDate.js'
import { dailyNoteBlockId } from '@/plugins/daily-notes/dailyNotes.js'
import { clipLine, oneLine, textHeadSql } from './text.ts'

/** How an agent names a block, in the order they are tried:
 *  - `((id))` / `^prefix` — explicitly an id or id prefix;
 *  - `[[Name]]` — explicitly a page name (exact alias);
 *  - a bare string: an existing id, a UUID, a unique hex id prefix of at
 *    least {@link MIN_ID_PREFIX} characters, an exact alias, then a date
 *    expression (today, 2026-06-18, "next monday") naming its daily note.
 *
 *  Alias before date, so a page literally named "Today" wins over the date —
 *  the same answer `[[Today]]` gives in content. */
export type BlockRefVia = 'id' | 'prefix' | 'alias' | 'date' | 'verbatim'

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
  /** `id` admits only an id or id prefix — for a target a write modifies or
   *  destroys, where resolving a name or a date is one typo from the wrong block. */
  accept?: 'any' | 'id'
}

export const MIN_ID_PREFIX = 6
const SHORT_ID_LENGTHS = [8, 12, 16] as const
const MAX_PREFIX_CANDIDATES = 10

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]*$/i

/** Its message reaches an agent verbatim through the CLI and MCP, so every
 *  piece of user text in it (the ref, candidate content, aliases) is
 *  neutralized like any other display text. */
export class BlockRefError extends Error {
  constructor(message: string, readonly candidates: readonly string[] = []) {
    super(message)
    this.name = 'BlockRefError'
  }
}

/** Upper bound for an index range scan over ids starting with `prefix`:
 *  U+10FFFF encodes above every byte an id can contain, so under SQLite's
 *  BINARY collation `id >= prefix AND id < prefix || char(1114111)` is
 *  exactly "starts with prefix" — and, unlike LIKE, uses the primary key. */
const PREFIX_RANGE_SQL = 'id >= ? AND id < ? || char(1114111)'

const PREFIX_MATCHES_SQL = `
  SELECT id, deleted FROM blocks
   WHERE ${PREFIX_RANGE_SQL}
   ORDER BY deleted, id
   LIMIT ${MAX_PREFIX_CANDIDATES + 1}
`

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

const prefixMatches = async (repo: Repo, prefix: string): Promise<string[]> => {
  const rows = await repo.db.getAll<{id: string, deleted: number}>(PREFIX_MATCHES_SQL, [prefix, prefix])
  const live = rows.filter(row => row.deleted === 0)
  // A soft-deleted block answers only when nothing live does, so a prefix
  // printed for a live block keeps meaning that block after a sibling with
  // the same prefix is deleted — and a deleted block's own prefix still
  // resolves, so a view can say it is deleted and print its full id.
  return (live.length > 0 ? live : rows).map(row => row.id)
}

const describeCandidates = async (repo: Repo, ids: readonly string[]): Promise<string> => {
  const rows = await repo.db.getAll<{id: string, content: string | null}>(
    `SELECT b.id AS id, ${textHeadSql('b.content', 200)} AS content FROM json_each(?) j JOIN blocks b ON b.id = j.value`,
    [JSON.stringify(ids)],
  )
  const byId = new Map(rows.map(row => [row.id, row.content ?? '']))
  return ids
    .map(id => `  ${clipLine(id, 64).text}  ${clipLine(byId.get(id) ?? '', 60).text}`)
    .join('\n')
}

const resolveIdLike = async (
  repo: Repo,
  text: string,
): Promise<BlockRefResolution | null> => {
  // Verbatim: sync and restore admit non-canonical (mixed-case) ids, and
  // lowercasing one would read a different row, or none.
  if (UUID_RE.test(text)) return {id: text, via: 'id'}
  const exists = await repo.db.getOptional(EXISTS_SQL, [text])
  if (exists) return {id: text, via: 'id'}
  if (text.length < MIN_ID_PREFIX || !ID_PREFIX_RE.test(text)) return null

  const prefix = text.toLowerCase()
  const matches = await prefixMatches(repo, prefix)
  if (matches.length === 1) return {id: matches[0], via: 'prefix'}
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_PREFIX_CANDIDATES)
    const more = matches.length > MAX_PREFIX_CANDIDATES ? '\n  …and more' : ''
    throw new BlockRefError(
      `Id prefix "${oneLine(text)}" is ambiguous; it matches:\n${await describeCandidates(repo, shown)}${more}\n`
      + 'Pass more characters of the id.',
      shown,
    )
  }
  return null
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
    `No block matches "${oneLine(ref)}" (tried: id, id prefix, page name, date).${hint}`,
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
    throw new BlockRefError(`No block has id or id prefix "${oneLine(ref)}". This operation takes an id (or a unique prefix of one), not a name.`)
  }
  throw await notFound(repo, ref, text, workspaceId)
}

/** Prefix lookup is lowercase (canonical ids are), so only an id already in
 *  that form is shortened; any other prints whole and resolves exactly. */
const CANONICAL_PREFIXABLE_RE = /^[0-9a-f][0-9a-f-]*$/

const isShortenable = (id: string): boolean =>
  id.length > SHORT_ID_LENGTHS[0] && CANONICAL_PREFIXABLE_RE.test(id)

const SHORT_ID_COUNTS_SQL = `
  SELECT j.value AS id,
         (SELECT deleted FROM blocks WHERE id = j.value) AS deleted,
         (SELECT count(*) FROM blocks b
           WHERE b.id >= substr(j.value, 1, ?) AND b.id < substr(j.value, 1, ?) || char(1114111)
             AND b.deleted = 0) AS live,
         (SELECT count(*) FROM blocks b
           WHERE b.id >= substr(j.value, 1, ?) AND b.id < substr(j.value, 1, ?) || char(1114111)) AS total
    FROM json_each(?) j
`

/** Whether the prefix resolves back to this id under `prefixMatches`' rule:
 *  live blocks answer first, so a live id needs to be the only live match and
 *  a deleted one needs no live match at all. */
const prefixResolvesBack = (row: {deleted: number | null, live: number, total: number}): boolean =>
  row.deleted === 0 ? row.live === 1 : row.deleted === 1 && row.live === 0 && row.total === 1

/** The shortest prefix of each id (8, 12 or 16 characters, else the whole id)
 *  that {@link resolveBlockRef} resolves back to it — deleted ids included,
 *  which a prefix shared with any live block would not reach.
 *  Ids that are not hex-like are returned whole, since only hex input is
 *  treated as a prefix. One index probe per id per length tried. */
export const shortIds = async (
  repo: Repo,
  ids: Iterable<string>,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  let pending: string[] = []
  for (const id of new Set(ids)) {
    if (isShortenable(id)) pending.push(id)
    else out.set(id, id)
  }
  for (const length of SHORT_ID_LENGTHS) {
    if (pending.length === 0) break
    const rows = await repo.db.getAll<{id: string, deleted: number | null, live: number, total: number}>(
      SHORT_ID_COUNTS_SQL,
      [length, length, length, length, JSON.stringify(pending)],
    )
    const ambiguous = new Set<string>()
    for (const row of rows) {
      if (prefixResolvesBack(row)) out.set(row.id, row.id.slice(0, length))
      else ambiguous.add(row.id)
    }
    pending = pending.filter(id => ambiguous.has(id))
  }
  for (const id of pending) out.set(id, id)
  return out
}
