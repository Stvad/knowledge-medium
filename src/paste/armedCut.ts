/*
 * The armed cut: the one cut whose blocks a paste should MOVE rather than
 * copy. Cut no longer deletes, so this record is the whole difference
 * between "cut" and "copy".
 *
 * There is exactly one record, shared by every tab of this origin
 * (localStorage, with an in-memory copy where storage is unavailable). The
 * OS clipboard holds one thing at a time, and the record is checked against
 * it on every paste by digest of the clipboard text, so a record can be
 * stale but never wrong: if the user copied something else since, the paste
 * text no longer matches and the paste is an ordinary one.
 *
 * Every in-app clipboard write updates it: a cut arms, any other copy
 * disarms. Writes from other apps can't, which is what the digest check is
 * for. Inherent limit: plain text from elsewhere that is IDENTICAL to the
 * cut's text matches it.
 */

import { CallbackSet } from '@/utils/callbackSet.js'

/** The record. `rootIds` are the cut roots in document order (descendants
 *  ride along inside them). */
export interface ArmedCut {
  readonly cutId: string
  readonly workspaceId: string
  readonly rootIds: readonly string[]
  /** SHA-256 of the clipboard text the cut wrote — never the text itself,
   *  so cut content doesn't sit in localStorage. */
  readonly textDigest: string
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
  const store = storage()
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
    } catch {
      // Blocked storage: the cut stays armed in this tab only.
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
  {workspaceId, rootIds}: {workspaceId: string; rootIds: readonly string[]},
): Promise<void> => {
  const cut: ArmedCut = {
    cutId: crypto.randomUUID(),
    workspaceId,
    rootIds: [...rootIds],
    textDigest: await digest(text),
  }
  writeRaw(JSON.stringify(cut))
}

/** Clear the armed cut — only if it is still `cutId` when one is given, so a
 *  cut armed since (in this tab or another) survives. */
export const disarmCut = (cutId?: string): void => {
  const current = getArmedCut()
  if (cutId !== undefined && current?.cutId !== cutId) return
  if (current === null && readRaw() === null) return
  writeRaw(null)
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
