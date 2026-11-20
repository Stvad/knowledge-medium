import { derivedBlockId } from '@/data/derivedIds'

// Kept apart from ids.ts, whose daily-page resolution pulls in the daily-notes
// plugin, so node scripts can derive an imported block's id cheaply.

// Fixed namespace for Roam-import block ids. Picking it once and never
// changing it keeps re-imports of the same export idempotent: a second
// run upserts the same ids instead of creating duplicates.
export const ROAM_IMPORT_NS = 'b8d6f1c2-7e9a-4f4d-a4f1-2c0a3a6e7f01'

// Deterministic id for a non-daily Roam block. Workspace-scoped so the
// same Roam graph imported into two workspaces produces distinct ids.
export const roamBlockId = (workspaceId: string, roamUid: string): string =>
  derivedBlockId({namespace: ROAM_IMPORT_NS, key: `${workspaceId}:roam:${roamUid}`})
