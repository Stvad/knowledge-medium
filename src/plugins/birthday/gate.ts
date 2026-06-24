/*
  The targeting gate.

  We deliberately do NOT ship the recipient's email or user id in source.
  Instead we ship the SHA-256 of `WOLF_SALT + <user id>` and compare it
  against the hash of the live user's id at runtime. A v4 uuid carries
  ~122 bits of entropy, so the digest isn't reversible back to the id (the
  salt is belt-and-suspenders against confirming a guessed id), and a bare
  MM-DD date constant identifies no one on its own. Net: the bundle reveals
  neither who the surprise is for nor — without hashing your own id —
  whether it's you.

  Until `WOLF_USER_HASH` is filled in, `isRecipient` returns false for
  everyone, so shipping this to production is inert: nothing fires until
  the real hash is locked in (or the dev force flag is set).
*/

/** Birthday, local time. Month is 1-based here for readability; the check
 *  below converts to JS's 0-based month. A date alone is not PII. */
const BIRTHDAY_MONTH = 6
const BIRTHDAY_DAY = 23

/** Arbitrary constant; only there to de-rainbow-table the digest. */
const WOLF_SALT = 'ftm-wolf-2bf1c0'

/** SHA-256 of `WOLF_SALT + <recipient user id>`, lowercase hex. The id is
 *  the Supabase auth uuid (`sessionUserToAppUser` → `session.user.id`),
 *  which is what `repo.user.id` carries at runtime. */
const WOLF_USER_HASH =
  '23a3429659325a626c72a4f4655947f72c3a0e8742bc12883bb8ff5c912f437e'

/** Dev/preview override key. `localStorage['birthday:force'] = '1'` makes
 *  both the date and recipient checks read true, so the whole celebration
 *  can be exercised on any account on any day. Never set in production. */
const FORCE_KEY = 'birthday:force'

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function isForced(): boolean {
  try {
    return window.localStorage?.getItem(FORCE_KEY) === '1'
  } catch {
    return false
  }
}

/** Local-date check (a birthday is a local-midnight thing, not UTC). */
export function isBirthdayToday(now: Date = new Date()): boolean {
  if (isForced()) return true
  return now.getMonth() === BIRTHDAY_MONTH - 1 && now.getDate() === BIRTHDAY_DAY
}

export async function isRecipient(userId: string): Promise<boolean> {
  if (isForced()) return true
  if (!userId) return false
  try {
    return (await sha256Hex(WOLF_SALT + userId)) === WOLF_USER_HASH
  } catch {
    return false
  }
}

/** Dedup key for the once-per-cycle bits (overlay, theme activation).
 *  Forced runs use a sentinel so the celebration re-fires on every reload
 *  while iterating, instead of being deduped by a real year. */
export function celebrationCycle(now: Date = new Date()): string {
  return isForced() ? 'force' : String(now.getFullYear())
}

/** Milliseconds until the next local midnight, used to re-evaluate the
 *  gate when the app stays open across a day boundary (so the theme
 *  activates / restores without a manual reload). */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  )
  return next.getTime() - now.getTime()
}
