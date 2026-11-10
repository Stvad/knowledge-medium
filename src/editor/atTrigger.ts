import { matchCharTrigger, type TriggerMatch } from './triggerMatch'

/** The `@` trigger family. Each cursor position belongs to at most one of
 *  these, so two sources never merge into one dropdown and no row can
 *  jump above another under Enter:
 *   - `@@query` — places (geo);
 *   - a bare `@` — the hand-off row into `@@` (geo);
 *   - `@query` — contributor mentions (contributors).
 *  A bare `@` goes to places rather than listing contributors, so `@` +
 *  Enter cannot mention (and so dispatch) anyone. */

export const matchPlaceTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@', {doubled: 'require'})

const matchSingleAt = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@', {doubled: 'reject'})

export const matchBareAt = (text: string, pos: number): TriggerMatch | null => {
  const match = matchSingleAt(text, pos)
  return match?.query === '' ? match : null
}

export const matchMentionTrigger = (text: string, pos: number): TriggerMatch | null => {
  const match = matchSingleAt(text, pos)
  return match && match.query !== '' ? match : null
}
