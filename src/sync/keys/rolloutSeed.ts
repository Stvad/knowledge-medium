/**
 * §6 rollout pin-seed — the one-time bootstrap that pins pre-existing
 * memberships from the server's `encryption_mode`.
 *
 * The first pin-aware boot finds every workspace unpinned. We initialize those
 * pins directly from the server flag — the ONE place the design trusts it —
 * because at rollout no E2EE workspace exists yet, so there's nothing to
 * misrepresent (every workspace is 'none' → 'plaintext'). Fires at most once
 * per (user, device); thereafter an unpinned workspace always takes the
 * steady-state gate (branch a key-required / branch b quarantine), never the
 * seed (seedModePinsOnce + arePinsSeeded enforce the once-only marker in
 * wipe-surviving localStorage).
 *
 * Reads the LOCAL `workspaces` table, so on an established device every synced
 * membership is already present and gets pinned before the observer/gate read
 * pins. A genuinely-fresh device seeds whatever has synced so far (often
 * nothing) and the rest take the gate — the accepted "one resolution step per
 * workspace per new device" cost.
 */

import { arePinsSeeded, seedModePinsOnce, type SeedEntry } from './modePin.js'

interface WorkspaceModeRow {
  readonly id: string
  readonly encryption_mode: string
}

/** Minimal read surface — the PowerSync DB satisfies it. */
export interface SeedReader {
  getAll<T>(sql: string): Promise<T[]>
}

export const seedModePinsFromWorkspaces = async (
  db: SeedReader,
  userId: string,
): Promise<number> => {
  // Short-circuit before touching the DB if this user already seeded — keeps
  // the once-only guarantee cheap on every boot.
  if (arePinsSeeded(userId)) return 0
  const rows = await db.getAll<WorkspaceModeRow>(
    'SELECT id, encryption_mode FROM workspaces',
  )
  const entries: SeedEntry[] = rows.map((row) => ({
    workspaceId: row.id,
    serverMode: row.encryption_mode === 'e2ee' ? 'e2ee' : 'plaintext',
  }))
  return seedModePinsOnce(userId, entries)
}
