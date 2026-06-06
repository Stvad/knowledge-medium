/**
 * §6 rollout pin-seed — the one-time bootstrap that pins pre-existing
 * memberships from the server's `encryption_mode`.
 *
 * ⚠️ PLANNED REMOVAL (issue #116). This server-trusting seed exists ONLY for the
 * coordinated rollout window (no E2EE workspace exists yet, so trusting the flag
 * is safe). It carries a narrow, irreducible downgrade residual on a fresh
 * device whose first-boot seal write fails and later recovers with post-rollout
 * data present. Once the rollout cohort has seeded (~1 week after release),
 * DELETE this module + its caller so future fresh devices gate every unpinned
 * workspace — which permanently closes the residual.
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
 * SAFETY rests on WHEN this runs: the caller invokes it AFTER `db.init()` but
 * BEFORE `db.connect()`, so the `workspaces` table holds ONLY rows persisted on
 * disk by a prior, pre-this-release session. Those predate e2ee existing at all,
 * so a row's `encryption_mode` can't be a downgraded e2ee workspace — trusting
 * it is safe by construction. A fresh device / profile has no on-disk rows here,
 * so it seeds nothing and marks-seeded; every workspace that syncs in afterward
 * (including any e2ee one a hostile server flags `none`) takes the
 * first-encounter gate, never this server-trusting path. This is what limits the
 * seed to the genuine rollout cohort without a separate cohort signal.
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
  try {
    return seedModePinsOnce(userId, entries)
  } catch (err) {
    // BEST-EFFORT: setModePin throws if localStorage is unavailable / blocked
    // (private mode, storage disabled). The seed is only an optimization — it
    // spares pre-existing workspaces a first-encounter gate — so a write
    // failure must NOT abort startup. Boot proceeds; without pins those
    // workspaces hit the gate, but the app still loads.
    console.warn('[rolloutSeed] pin-seed failed (storage unavailable?); continuing without it', err)
    return 0
  }
}
