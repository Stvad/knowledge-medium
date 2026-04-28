import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DAILY_NOTE_NS } from '@/data/dailyNotes'

// Cheap structural enforcement that the SQL side of the deterministic
// daily-note id stays in lockstep with the JS side. If someone rotates
// the namespace UUID in dailyNotes.ts and forgets the SQL (or vice
// versa), this test trips before the divergence ships and freshly-
// created workspaces start producing duplicate daily notes for day 0.
//
// We can't run the SQL function from vitest (no DB in test env), so we
// content-match: assert the migration source includes the same NS
// literal and the same `workspace_id || ':' || iso_date` input shape.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../supabase/migrations/20260428123232_deterministic_seed_daily_note.sql',
)

describe('DAILY_NOTE_NS parity with supabase migration', () => {
  it('migration references the same namespace UUID as the JS constant', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    expect(sql).toContain(DAILY_NOTE_NS)
  })

  it('migration uses the same name-input shape (workspace_id colon iso)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    // Mirrors `${workspaceId}:${iso}` in dailyNoteBlockId(). Spacing-
    // tolerant so a Postgres style nit doesn't break the check.
    expect(sql).toMatch(/uuid_generate_v5\([^)]*workspace_id\s*\|\|\s*':'\s*\|\|\s*v_iso/)
  })
})
