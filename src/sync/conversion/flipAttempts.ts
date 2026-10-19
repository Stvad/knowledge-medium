/**
 * When this device last sent a flip. A flip whose response was lost may still
 * commit, under the canary of the key it was sent with, so that key may be
 * dropped for a new one only once such a flip can no longer land. The flip
 * takes its locks NOWAIT and does no other work, so it ends within seconds.
 */

export interface FlipAttempts {
  /** Recorded just before each flip request is sent. */
  markSent(): void
  /** A flip sent from this device could still commit. */
  sentRecently(): boolean
  clear(): void
}

export const FLIP_SETTLED_MS = 10 * 60_000

const storageKey = (userId: string, workspaceId: string): string =>
  `kmp-e2ee-flip-sent:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`

/** localStorage, which preflight requires to be writable. */
export const localFlipAttempts = (userId: string, workspaceId: string, now: () => number = Date.now): FlipAttempts => {
  const key = storageKey(userId, workspaceId)
  return {
    markSent: () => localStorage.setItem(key, String(now())),
    sentRecently: () => {
      const raw = localStorage.getItem(key)
      if (raw === null) return false
      const sent = Number(raw)
      // An unreadable value counts as recent: it only delays a fresh key.
      return Number.isNaN(sent) || now() - sent < FLIP_SETTLED_MS
    },
    clear: () => localStorage.removeItem(key),
  }
}

export class InMemoryFlipAttempts implements FlipAttempts {
  sentAt: number | null = null
  constructor(private readonly now: () => number = Date.now) {}
  markSent() {
    this.sentAt = this.now()
  }
  sentRecently() {
    return this.sentAt !== null && this.now() - this.sentAt < FLIP_SETTLED_MS
  }
  clear() {
    this.sentAt = null
  }
}
