/**
 * Landing resolver: when the app boots into an empty layout (URL hash
 * has no panels), land the user on today's daily note. Get-or-create
 * the note via the deterministic-id helper so two clients booting
 * offline converge on the same row when they later sync.
 *
 * First-run discoverability (the `[[Tutorial]]` bullet) is NOT handled
 * here — that belongs to the onboarding plugin, which contributes its own
 * higher-precedence landing resolver, seeds the Tutorial pages, drops the
 * bullet on today's note, and then defers the landing target back to this
 * resolver. So daily-notes no longer knows anything about the tutorial.
 *
 * Returns the block id of today's daily note. App.tsx is responsible
 * for the rest of the bootstrap chain (replaceHash, panel-row tx);
 * the resolver intentionally stops here so the same surface can be
 * used to land somewhere that isn't a daily note (e.g. a future
 * "open last panel" plugin) without duplicating the navigation
 * plumbing.
 */
import type { Repo } from '@/data/repo.js'
import type { WorkspaceLandingResolver } from '@/extensions/core.js'
import { aliasesProp } from '@/data/properties.js'
import {
  JOURNAL_ALIAS,
  dailyNoteAliasesFor,
  dailyNoteBlockId,
  getOrCreateDailyNote,
  journalBlockId,
  todayIso,
} from './dailyNotes.ts'
import { anyBlockTombstoned } from '@/data/blockLiveness.js'

/** Raw, tombstone-tolerant alias read — `properties_json` (and its
 *  `aliases` entry) survives a soft-delete; only the `block_aliases`
 *  INDEX gets cleared on the flip (see `blocks_alias_update`,
 *  clientSchema.ts). Used only by the exclusion check below, which
 *  needs to recognise `excludeBlockId` as "was today's identity" even
 *  after it's been deleted and can no longer be found via
 *  `aliasLookup`. Same "Block facade can't tell deleted from missing"
 *  reasoning as `anyBlockTombstoned` — reads the row directly. */
const decodeAliases = (propertiesJson: string): readonly string[] => {
  try {
    const props = JSON.parse(propertiesJson) as Record<string, unknown>
    const encoded = props[aliasesProp.name]
    return encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

/** Depth cap for the ancestor walk. Outlines nest, but a daily note's subtree
 *  is shallow in practice; a cap keeps a cyclic or corrupt parent chain from
 *  hanging a navigation. */
const MAX_ANCESTOR_WALK = 64

/** Aliases on `id` AND on every ancestor, tombstones included.
 *
 *  The ancestors matter because delete CASCADES: when the adopted note is
 *  deleted while the pane is zoomed into one of its children, the excluded
 *  block is that child, whose own alias bag names no date. Checking only the
 *  excluded block reads that as "unrelated page deleted" and mints a fresh
 *  empty note for today — moments after the user deleted the one they were
 *  looking at. */
const rawAliasesWithAncestors = async (repo: Repo, id: string): Promise<readonly string[]> => {
  const collected: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  for (let depth = 0; cursor !== null && depth < MAX_ANCESTOR_WALK; depth++) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const row: {properties_json: string, parent_id: string | null} | null =
      await repo.db.getOptional<{properties_json: string, parent_id: string | null}>(
        'SELECT properties_json, parent_id FROM blocks WHERE id = ?', [cursor],
      )
    if (!row) break
    collected.push(...decodeAliases(row.properties_json))
    cursor = row.parent_id
  }
  return collected
}

export const todayDailyNoteLanding: WorkspaceLandingResolver = async ({
  repo,
  workspaceId,
  excludeBlockId,
}) => {
  const iso = todayIso()
  const id = dailyNoteBlockId(workspaceId, iso)
  if (excludeBlockId) {
    // Recovery context. `getOrCreateDailyNote` RESTORES a soft-deleted row, so
    // answering here can undo a delete. Decline when we'd hand back the
    // excluded block itself (id is a pure function of workspace+day, so this
    // costs nothing)...
    if (id === excludeBlockId) return null
    // ...and, more broadly, whenever today's note is currently a tombstone.
    // The excluded id is the vanished page of the pane being recovered, which
    // is NOT necessarily the root of the deleted subtree: a pane zoomed into a
    // CHILD of today's note recovers with the child's id, and an exact-id check
    // would sail past and resurrect the deleted parent note. A tombstone means
    // someone deleted it; recovery is never the right moment to bring it back.
    //
    // The Journal counts too: `getOrCreateDailyNote` calls
    // `getOrCreateJournalBlock`, which restores a soft-deleted Journal row — so
    // recovering after a Journal delete would resurrect it and hang a fresh
    // daily note under it.
    //
    // `anyBlockTombstoned` reads the rows directly because the Block facade
    // can't tell "deleted" (decline) from "never existed" (creating it is fine
    // and wanted) — see its docblock.
    if (await anyBlockTombstoned(repo, [id, journalBlockId(workspaceId)])) return null
    // issue #378 residual: alias-first resolution means today's note (or the
    // Journal) can live at an ADOPTED id that's never touched the
    // deterministic `id` at all — a fresh workspace where the user aliased a
    // page to today's date, or to 'Journal', before ever landing here. The
    // two checks above are blind to that (neither `id` nor the Journal's
    // deterministic id was ever created, so neither reads as "tombstoned").
    // If the adopted claimant was JUST deleted — either `excludeBlockId`
    // itself, or an ancestor of it, since delete cascades and the pane may
    // have been zoomed into a child — decline for the same reason:
    // getOrCreateDailyNote can no longer find it as a live claimant, so
    // answering here mints a FRESH row for today right after the user deleted
    // the one they were looking at.
    const excludedAliases = await rawAliasesWithAncestors(repo, excludeBlockId)
    const [longLabel, isoLabel] = dailyNoteAliasesFor(iso)
    if (
      excludedAliases.includes(longLabel)
      || excludedAliases.includes(isoLabel)
      || excludedAliases.includes(JOURNAL_ALIAS)
    ) return null
  }
  const dailyNote = await getOrCreateDailyNote(repo, workspaceId, iso)
  return dailyNote.id
}
