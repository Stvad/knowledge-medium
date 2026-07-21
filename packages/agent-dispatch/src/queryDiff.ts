/**
 * Query-watcher row diffing — the union-cursor dedup that decides which
 * query rows are "new" (and therefore trigger a billed agent run). Pure and
 * synchronous: no DB, no config, no I/O.
 *
 * Deliberately kept in its own module, separate from `watchers.ts` (which
 * re-exports it for the daemon's call sites). `watchers.ts` imports
 * `./config.js`, which pulls in `@knowledge-medium/agent-cli/config`; that
 * package export resolves to the untracked `packages/agent-cli/dist/`, so a
 * clean CI runner with no prior `pnpm run compile` fails module resolution
 * before any code runs. The nightly fuzz sweep hits exactly that path
 * (`fuzz-nightly.yml` runs `pnpm fuzz` right after `pnpm install`), so this
 * file keeping ZERO heavy imports is what lets `queryDiff.fuzz.test.ts`
 * import the diff logic and run pre-build.
 */

/** Rows must carry a stable `id`; anything else is passed to the prompt. */
export interface QueryRow {
  id: string
  [key: string]: unknown
}

const rowId = (row: unknown): string | null => {
  if (!row || typeof row !== 'object') return null
  const id = (row as {id?: unknown}).id
  return typeof id === 'string' && id ? id : null
}

export interface QueryDiff {
  newRows: QueryRow[]
  /** Union of everything ever seen (bounded) — the next cursor. */
  seenIds: string[]
  /** Rows without a usable id (skipped, surfaced for logging). */
  invalidRows: number
  /** Result set exceeds the cursor bound — diffing refused (see below). */
  oversized: boolean
}

/** Cursor retention bound. Oldest ids are forgotten past this, which
 *  can re-fire an ancient row that re-enters the result set — the
 *  cheap failure direction (one extra run) vs unbounded growth. */
export const MAX_CURSOR_IDS = 20_000

/**
 * Diff current query results against the previously-seen id UNION.
 * First run (`prevIds === null`) establishes the baseline WITHOUT
 * firing — a fresh watcher shouldn't replay the whole backlog.
 *
 * The cursor is a union, not the current id set: with a LIMIT'd or
 * ordered query, rows rotate out and back in as other rows churn —
 * a current-set cursor would re-fire (and re-bill) on every rotation.
 *
 * A result set larger than MAX_CURSOR_IDS is refused outright
 * (`oversized`, no diff, cursor untouched): the baseline could only
 * store a truncated window, so every later tick would see the dropped
 * ids as "new" and fire until runsPerHour drains — a stable oversized
 * query must be narrowed, not diffed.
 */
export const diffQueryRows = (rows: unknown[], prevIds: string[] | null): QueryDiff => {
  const valid: QueryRow[] = []
  let invalidRows = 0
  for (const row of rows) {
    const id = rowId(row)
    if (id) valid.push(row as QueryRow)
    else invalidRows += 1
  }

  if (valid.length > MAX_CURSOR_IDS) {
    return {newRows: [], seenIds: prevIds ?? [], invalidRows, oversized: true}
  }

  if (prevIds === null) {
    return {newRows: [], seenIds: valid.map(row => row.id), invalidRows, oversized: false}
  }

  const prev = new Set(prevIds)
  const newRows = valid.filter(row => !prev.has(row.id))
  // Currently-visible ids go LAST so the bound evicts only ids that
  // have left the result set — evicting a visible id re-fires (and
  // re-bills) it on the very next poll. Visible count ≤ the bound
  // (oversized was rejected above), so every visible id survives.
  const currentIds = valid.map(row => row.id)
  const currentSet = new Set(currentIds)
  const seenIds = [...prevIds.filter(id => !currentSet.has(id)), ...currentIds].slice(-MAX_CURSOR_IDS)
  return {newRows, seenIds, invalidRows, oversized: false}
}
