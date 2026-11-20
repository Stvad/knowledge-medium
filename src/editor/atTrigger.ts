import { matchCharTrigger, type TriggerMatch } from './triggerMatch'

/** The `@` trigger family:
 *   - `@@query` — places (geo);
 *   - `@query` — contributor mentions (contributors);
 *   - a bare `@` — both: geo's hand-off row into `@@`, then every
 *     contributor. The hand-off is an unfiltered result and the
 *     contributors a filtered one, which CodeMirror always ranks below it,
 *     so `@` + Enter turns into `@@` rather than mentioning (and so
 *     dispatching) anyone. No other position is shared. */

export const matchPlaceTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@', {doubled: 'require'})

export const matchMentionTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@', {doubled: 'reject'})

export const matchBareAt = (text: string, pos: number): TriggerMatch | null => {
  const match = matchMentionTrigger(text, pos)
  return match?.query === '' ? match : null
}
