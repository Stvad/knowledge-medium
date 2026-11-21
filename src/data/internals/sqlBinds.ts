/*
 * The SQLite bound-parameter ceiling, and the two things every `IN (…)`
 * read over a caller-sized id list needs from it.
 *
 * Not a policy, a platform fact with one statement of it: the cap is
 * build-dependent — 999 on older builds, 32766 since 3.32 — and nothing
 * in the app can read it back, so every such read stays under the old
 * floor. Each caller keeps its own note about why ITS list can exceed
 * that; what they share is the number and the reason it is that number.
 */

/** Max ids per `IN (…)` read. Well under the 999 floor, so a caller that
 *  chunks on it cannot throw on any build. */
export const MAX_IDS_PER_IN_CLAUSE = 500

/** `?, ?, …` for `count` bound parameters. */
export const buildInClause = (count: number): string =>
  Array.from({length: count}, () => '?').join(', ')
