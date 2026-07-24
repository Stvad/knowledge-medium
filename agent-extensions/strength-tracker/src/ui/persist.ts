/** Device-local persistence for the in-progress logging draft.
 *
 *  An unfinished workout is inherently single-device and transient — but it
 *  must never be lost to a reload or a tab switch (backyard gym, 1am, a phone
 *  that reloads the tab under memory pressure). We mirror the live draft into
 *  localStorage on every edit and restore it on mount when it belongs to the
 *  same (day, session), then clear it once the workout is written.
 *
 *  Deliberately NOT a synced block: a half-logged session isn't shared state,
 *  and round-tripping it through the block store on every keystroke would be
 *  slow and would spam the sync queue. If cross-device resume is ever wanted,
 *  promote this to a ui-state block. Using localStorage as the source of truth
 *  for edits also makes the draft-rebuild effect idempotent: a spurious
 *  prescription recompute re-reads the persisted edits instead of clobbering
 *  them.
 */

import type {SessionType} from '../engine/types'
import type {DraftExercise} from './draft'

/** Bump when the persisted shape changes so stale drafts are ignored. */
const VERSION = 1

interface PersistedDraft {
  v: number
  day: string
  session: SessionType
  exercises: DraftExercise[]
}

const keyFor = (workspaceId: string, pageId: string): string =>
  `strength-tracker:draft:${workspaceId}:${pageId}`

export const saveDraft = (
  workspaceId: string,
  pageId: string,
  day: string,
  session: SessionType,
  exercises: readonly DraftExercise[],
): void => {
  try {
    const payload: PersistedDraft = {v: VERSION, day, session, exercises: exercises as DraftExercise[]}
    localStorage.setItem(keyFor(workspaceId, pageId), JSON.stringify(payload))
  } catch {
    // private mode / quota exceeded — persistence is best-effort.
  }
}

/** Restore the draft only if it belongs to the same (day, session) we're
 *  about to log; otherwise it's stale and the caller builds fresh. */
export const loadDraft = (
  workspaceId: string,
  pageId: string,
  day: string,
  session: SessionType,
): DraftExercise[] | null => {
  try {
    const raw = localStorage.getItem(keyFor(workspaceId, pageId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedDraft
    if (parsed.v !== VERSION || parsed.day !== day || parsed.session !== session) return null
    if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) return null
    return parsed.exercises
  } catch {
    return null
  }
}

export const clearDraft = (workspaceId: string, pageId: string): void => {
  try {
    localStorage.removeItem(keyFor(workspaceId, pageId))
  } catch {
    // ignore
  }
}
