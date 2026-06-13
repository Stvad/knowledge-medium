/**
 * Generic "spread a set of blocks across upcoming days" operation.
 * Picks the right `BlockDateAdapter` per block via the
 * `blockDateAdapterFacet`, so the same surface reschedules SRS cards
 * (via `srsBlockDateAdapter`), inline date references (via
 * `referenceDateAdapter`), and any future adapter without per-kind
 * branching at the call site.
 *
 * Blocks without an applicable adapter are reported as `skipped`.
 * Setter failures (read-only repo, lost type, dangling target) are
 * absorbed inside `adapter.setIso` — they count toward `eligible`
 * but not `updated`.
 */
import type { Block } from '@/data/block'
import type { FacetRuntime } from '@/facets/facet.js'
import { addDaysIso, todayIso } from './dailyNotes.ts'
import { pickBlockDateAdapter } from './blockDateAdapter.ts'

export interface SpreadBlockDatesOptions {
  /** Window in days. Random target falls in `[today+1, today+days]`. */
  days: number
  /** Override for tests. */
  now?: Date
  /** Override for tests. */
  random?: () => number
}

export interface SpreadBlockDatesResult {
  /** Blocks with a date-adapter match (would be acted on). */
  eligible: number
  /** Blocks whose adapter actually committed a new date. */
  updated: number
  /** Blocks the spread couldn't touch (no adapter applies). */
  skipped: number
}

const normalizeDays = (days: number): number => {
  const wholeDays = Math.floor(days)
  if (!Number.isFinite(wholeDays) || wholeDays < 1) {
    throw new Error('Choose at least 1 day')
  }
  return wholeDays
}

/** Maps a `[0,1)` random value to an integer day offset in
 *  `[1, days]`. Exported so per-block randomness stays reproducible
 *  in tests. */
export const randomUpcomingDateOffset = (
  days: number,
  random: () => number = Math.random,
): number => {
  const dayCount = normalizeDays(days)
  const value = Math.max(0, Math.min(random(), 0.999999999999))
  return 1 + Math.floor(value * dayCount)
}

export const spreadBlockDates = async (
  runtime: FacetRuntime,
  blocks: readonly Block[],
  options: SpreadBlockDatesOptions,
): Promise<SpreadBlockDatesResult> => {
  const dayCount = normalizeDays(options.days)
  const random = options.random ?? Math.random
  const baseIso = todayIso(options.now ?? new Date())
  let eligible = 0
  let updated = 0

  for (const block of blocks) {
    // Hydrate the row so the adapter's sync `canHandle` (called by
    // `pickBlockDateAdapter`) has data to peek at. Mirrors the
    // existing SRS spread flow; without this, a brand-new block
    // facade whose row hasn't loaded yet would silently skip even
    // though it has a usable date adapter.
    if (!block.peek()) await block.load()
    const adapter = pickBlockDateAdapter(runtime, block)
    if (!adapter) continue

    eligible += 1
    const targetIso = addDaysIso(
      baseIso,
      randomUpcomingDateOffset(dayCount, random),
    )
    if (await adapter.setIso(block, targetIso)) updated += 1
  }

  return {
    eligible,
    updated,
    skipped: blocks.length - eligible,
  }
}
