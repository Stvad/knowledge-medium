/*
 * The armed cut: the one cut whose blocks a paste should MOVE rather than
 * copy. Cut deletes nothing, so this record is the whole difference
 * between "cut" and "copy".
 *
 * There is exactly one record, shared by every tab of this origin
 * (localStorage, with an in-memory copy where storage is unavailable). The
 * OS clipboard holds one thing at a time, and the record is checked against
 * it on every paste by digest of the clipboard text, so a record can be
 * stale but never wrong: if the user copied something else since, the paste
 * text no longer matches and the paste is an ordinary one.
 *
 * A cut arms it. Every other clipboard write in the app disarms it: the
 * async writes go through `@/utils/copy.js` (lint-enforced), and native copy
 * and cut events through `@/extensions/armedCutAppMount.js`. Writes from other
 * apps can't, which is what the digest check is for. Inherent limit: plain
 * text from elsewhere that is IDENTICAL to the cut's text matches it.
 */

import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import { showInfo } from '@/utils/toast.js'

/** The record. `rootIds` are the cut roots in document order (descendants
 *  ride along inside them). */
export interface ArmedCut {
  readonly cutId: string
  readonly workspaceId: string
  readonly rootIds: readonly string[]
  /** SHA-256 of the clipboard text the cut wrote — never the text itself,
   *  so cut content doesn't sit in localStorage. */
  readonly textDigest: string
  /** A paste has moved the blocks. The cut stays armed while the clipboard
   *  holds it, so the next paste moves them again rather than copying them
   *  (after an undo the originals are back in place, and a copy would
   *  duplicate them); it just stops dimming blocks the user has placed. */
  readonly pasted: boolean
}

export type ArmedCutMatch =
  | {kind: 'match'; cut: ArmedCut}
  /** A cut is armed, but the clipboard holds other text now. */
  | {kind: 'mismatch'; cut: ArmedCut}
  /** The clipboard is the cut, but this paste is in another workspace;
   *  blocks can't move between workspaces. */
  | {kind: 'other-workspace'; cut: ArmedCut}

const STORAGE_KEY = 'knowledge-medium:armed-cut'

let memoryRaw: string | null = null
/** Set while localStorage takes reads but refuses writes (a full quota):
 *  what it holds then is stale, so this tab reads its in-memory copy. */
let storageWriteFailed = false
let snapshot: {raw: string | null; cut: ArmedCut | null} = {raw: null, cut: null}
const listeners = new CallbackSet('armed-cut')

const storage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const readRaw = (): string | null => {
  const store = storageWriteFailed ? null : storage()
  if (store) {
    try {
      return store.getItem(STORAGE_KEY)
    } catch {
      // Blocked storage: the in-memory copy below is this tab's record.
    }
  }
  return memoryRaw
}

const writeRaw = (raw: string | null): void => {
  memoryRaw = raw
  const store = storage()
  if (store) {
    try {
      if (raw === null) store.removeItem(STORAGE_KEY)
      else store.setItem(STORAGE_KEY, raw)
      storageWriteFailed = false
    } catch {
      // The cut stays armed in this tab only.
      storageWriteFailed = true
    }
  }
  listeners.notify()
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)

/** Another build (or a hand edit) may have written the key, so anything not
 *  exactly this shape reads as "nothing armed". */
const parse = (raw: string | null): ArmedCut | null => {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<ArmedCut>
    if (typeof value.cutId !== 'string' || !value.cutId) return null
    if (typeof value.workspaceId !== 'string' || !value.workspaceId) return null
    if (typeof value.textDigest !== 'string' || !value.textDigest) return null
    if (!isStringArray(value.rootIds) || value.rootIds.length === 0) return null
    return {
      cutId: value.cutId,
      workspaceId: value.workspaceId,
      rootIds: value.rootIds,
      textDigest: value.textDigest,
      pasted: value.pasted === true,
    }
  } catch {
    return null
  }
}

/** The armed cut, or null. Referentially stable until the record changes,
 *  as `useSyncExternalStore` requires. */
export const getArmedCut = (): ArmedCut | null => {
  const raw = readRaw()
  if (raw !== snapshot.raw) snapshot = {raw, cut: parse(raw)}
  return snapshot.cut
}

/** Fires on every change in this tab, and on another tab's change via the
 *  `storage` event. */
export const subscribeArmedCut = (listener: () => void): (() => void) => {
  const off = listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    off()
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Line endings are the one thing platforms rewrite on the way through the
 *  clipboard (CRLF on Windows). */
const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

const digest = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(text)))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Arm a cut for `text`, the exact text just written to the clipboard. Call
 *  only after that write RESOLVED: a refused write leaves the previous
 *  clipboard content, which this record must not claim. */
export const armCut = async (
  text: string,
  {workspaceId, rootIds, undoTop}: {
    workspaceId: string
    rootIds: readonly string[]
    /** The cut workspace's top undo entry as the cut is armed; see
     *  {@link undoOrTakeBackCut}. */
    undoTop?: object | null
  },
): Promise<void> => {
  const cut: ArmedCut = {
    cutId: crypto.randomUUID(),
    workspaceId,
    rootIds: [...rootIds],
    textDigest: await digest(text),
    pasted: false,
  }
  armedUndoTop = undoTop === undefined ? null : {cutId: cut.cutId, entry: undoTop}
  writeRaw(JSON.stringify(cut))
}

/** Clear the armed cut — only if it is still `cutId` when one is given, so a
 *  cut armed since (in this tab or another) survives. */
export const disarmCut = (cutId?: string): void => {
  const current = getArmedCut()
  if (cutId !== undefined && current?.cutId !== cutId) return
  if (current === null && readRaw() === null) return
  armedUndoTop = null
  writeRaw(null)
}

/** Record that a paste moved `cutId`'s blocks (see `ArmedCut.pasted`). */
export const markCutPasted = (cutId: string): void => {
  const current = getArmedCut()
  if (current?.cutId !== cutId || current.pasted) return
  writeRaw(JSON.stringify({...current, pasted: true}))
}

/** Tab-local: the undo entry on top when this tab armed the cut. */
let armedUndoTop: {cutId: string; entry: object | null} | null = null

/** Undo, except right after a cut. A cut writes no undo entry (it deletes
 *  nothing), so the undo the user reaches for to take a cut back would
 *  otherwise revert their PREVIOUS edit. While the entry that was on top when
 *  this tab armed the cut is on top again (nothing edited since, or a paste
 *  of it undone), undo disarms the cut instead. */
export const undoOrTakeBackCut = async (repo: Repo): Promise<boolean> => {
  const cut = getArmedCut()
  if (cut && armedUndoTop?.cutId === cut.cutId &&
    armedUndoTop.entry === repo.undoManager.peekUndo(ChangeScope.BlockDefault)) {
    disarmCut(cut.cutId)
    showInfo('Cut cancelled')
    return true
  }
  return repo.undo()
}

/** How a paste of `text` in `workspaceId` relates to the armed cut; null when
 *  nothing is armed. */
export const matchArmedCut = async (
  text: string,
  workspaceId: string,
): Promise<ArmedCutMatch | null> => {
  const cut = getArmedCut()
  if (!cut) return null
  if (cut.textDigest !== await digest(text)) return {kind: 'mismatch', cut}
  if (cut.workspaceId !== workspaceId) return {kind: 'other-workspace', cut}
  return {kind: 'match', cut}
}
