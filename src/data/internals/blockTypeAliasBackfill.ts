/**
 * `block-type-name-alias-v1` — the catch-up half of the "a user-defined
 * type named X also claims the alias X" invariant.
 *
 * Going forward the invariant is maintained at write time by three paths:
 * `createTypeBlock` (claims the label in the creating tx),
 * `core.blockTypeTypeify` (claims it for every `#type` / programmatic tag),
 * and `writeBlockTypeLabel` (seeds it the first time a blank type is named).
 * Those landed 2026-07-02 / 2026-07-10; a type created before them carries a
 * `block-type:label` and no matching alias, so `[[X]]` mints a rival
 * alias-seat page instead of resolving to the type block. This backfill
 * closes that window on existing rows.
 *
 * Deliberately narrow — it runs unattended against live graphs:
 *   - **additive only.** It appends the type's name to whatever alias list
 *     the block already has; it never removes, reorders, or rewrites an
 *     existing entry, and never touches `content` or the type's label. A row
 *     whose stored alias value does not DECODE is skipped outright rather
 *     than appended to: `getAliases` degrades a codec error to `[]`, while
 *     the `block_aliases` trigger indexes every string element it finds, so
 *     a legacy `["Scribe", 1]` is a live claim that an append would silently
 *     overwrite. Same policy, same reason, as `claimLiteralDateAliases`
 *     (`plugins/references/referencesProcessor.ts`): losing a live binding is
 *     worse than leaving the name unclaimed.
 *   - **never steals a claim.** `tx.aliasClaimants` (not `aliasLookup` —
 *     sync-applied rows can land co-claimants that the `LIMIT 1` form hides)
 *     is checked inside the tx; any live claimant means the row is skipped
 *     and logged. A duplicate-named legacy type, or a real page that already
 *     owns the name, keeps what it has. Merging the two is a user decision,
 *     not a backfill's.
 *   - **survives a latent duplicate on some OTHER alias.** `blocks_alias_update`
 *     deletes and re-inserts the row's WHOLE alias list, re-checking each entry
 *     against `block_aliases_workspace_alias_unique` — so a pre-existing alias
 *     that another block latently co-claims (cross-client dupes sync in
 *     trigger-free; V1 leaves their merge latent) would abort a claim we never
 *     asked for, and one poisoned row would cost every type in the graph: the
 *     run throws, no marker is recorded, and it re-throws on every open forever.
 *     Every entry the write re-inserts is therefore PREFLIGHTED, not caught.
 *     Catching is not enough — in a `properties_migration = 'children'`
 *     workspace `setProperty` writes the value children first and the parent-bag
 *     collision surfaces later, from the children projection, outside any local
 *     try/catch (verified: the rejection arrives from `repo.tx`, not from
 *     `setProperty`).
 *   - **skips seed-owned rows.** `materializeTypeSeeds` mints code-authored
 *     `block-type` blocks at deterministic ids, and those were never pages.
 *     This one isn't cosmetic: `assertNoSeedDefinitionWrites` (`txEngine.ts`)
 *     THROWS `SeededDefinitionWriteError` on any `BlockDefault` write to such a
 *     row, so an un-skipped one aborts the whole run. The predicate here is
 *     `isValidSeededDefinition` — the guard's own, covering both seed
 *     grammars — rather than the `/type/`-only form the typeify processor uses.
 *   - **skips rows that aren't named user types.** `parseTypeDefinitionMetadata`
 *     is the same reader `UserTypesService.tryBuildType` builds `repo.types`
 *     through, so "what counts as a type, and what is it called" has one
 *     definition. A label-less row isn't a named type yet (`tryBuildType` drops
 *     it); naming it later goes through `writeBlockTypeLabel`, which seeds the
 *     alias then.
 *   - **skips a grammar-shaped label.** Both label-WRITING paths refuse one
 *     (`assertNotGrammarShapedLabel`); claiming `"[[Foo]]"` as alias text would
 *     mint a name that reads as a reference span.
 *
 * Because the claim is written through `repo.tx`, the kernel
 * `core.aliasClaimRederive` post-commit hook fires for every gained alias and
 * re-derives the `[[X]]` rows that stamped NULL while nothing claimed X — so
 * pre-existing references start resolving to the type without a reload. The
 * writes carry `source = 'user'` (the whole point of a `WorkspaceBackfill`
 * over a raw `db.execute`), so they upload and every other client converges.
 *
 * Two known exposures this does NOT address, both properties of the shared
 * `WorkspaceBackfill` machinery rather than of this pass:
 *   - the writes use `ChangeScope.BlockDefault` (forced: `aliasesProp`'s own
 *     scope is `BlockDefault`, and `assertPropertyWriteScope` demands
 *     policy-equivalence, so the non-undoable `Automation` is rejected). That
 *     scope is undoable, so the batch lands on the user's undo stack ~10-30s
 *     after open and one cmd-Z reverts every claim — with the marker already
 *     recorded, permanently. Fixing it needs a non-undoable scope for
 *     maintenance writes, or a record-suppressing tx option.
 *   - the marker is recorded after any non-throwing run, so a device still
 *     downloading its graph can burn it having seen few candidates (the
 *     daily-note:date regression shape). The marker is per-device and local,
 *     so any fully-synced device still completes the job for the fleet; the
 *     general fix is gating `scheduleWorkspaceBackfills` on `onFirstSync`.
 */

import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { isValidSeededDefinition } from '@/data/definitionSeeds'
import type { WorkspaceBackfill } from '@/data/facets'
import { parseAliasCollisionError } from '@/data/internals/raiseProtocol'
import { aliasesProp } from '@/data/properties'
import { isGrammarShapedLabel } from '@/data/referenceBlock'
import { parseTypeDefinitionMetadata } from '@/data/typeDefinitionMetadata'

/** Candidate rows: every live `block-type`-tagged block in this workspace.
 *  The interesting predicates (seed-owned, not a named type, alias already
 *  present, alias claimed elsewhere) are all re-checked per row inside the tx
 *  against the same helpers the write paths use — a JSON-shape guess in SQL
 *  would drift from the codecs. Types number in the dozens, so the loose scan
 *  costs nothing.
 *
 *  `ORDER BY` is load-bearing, not tidiness: with two same-named legacy types
 *  only one can claim the name, and an unordered scan picks whichever the
 *  physical `block_types` scan yields — sync-arrival order on one device,
 *  local-creation order on another. Two devices would then claim the name on
 *  DIFFERENT blocks and both uploads would stick (sync-apply skips the
 *  uniqueness trigger), leaving a permanent co-claim. Oldest-first matches the
 *  tie-break `aliasLookup` already uses. */
const SELECT_BLOCK_TYPE_BLOCKS_SQL = `
  SELECT b.id AS id
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${BLOCK_TYPE_TYPE}'
  WHERE b.workspace_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at, b.id
`

/** Tx batch size. Small because the candidate set is small; batching mainly
 *  buys partial progress across a mid-run failure. A failed run records no
 *  marker, so it re-scans on the next open — and the per-row rechecks make
 *  that idempotent. (A *successful* run is never re-scanned: the marker
 *  forecloses it. Re-running after that needs an `id` bump.) */
const BATCH_SIZE = 100

export const blockTypeNameAliasBackfill: WorkspaceBackfill = {
  id: 'block-type-name-alias-v1',
  run: async ({workspaceId, getAll, tx}) => {
    const rows = await getAll<{id: string}>(SELECT_BLOCK_TYPE_BLOCKS_SQL, [workspaceId])
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      await tx(
        async t => {
          for (const {id} of batch) {
            const row = await t.get(id)
            if (row === null) continue
            // Re-check inside the tx: `checkWorkspace` only rejects AFTER the
            // tx pins a workspace, so a foreign-workspace row handed to this
            // pass first would be written.
            if (row.workspaceId !== workspaceId) continue

            // Exactly the predicate `assertNoSeedDefinitionWrites` throws on.
            if (isValidSeededDefinition(row)) continue

            // Also the tombstone gate — `tx.get` does not filter deleted rows,
            // and a sync-applied delete can land between the candidate scan and
            // here. `parseTypeDefinitionMetadata` rejects `deleted` first, so
            // that rule stays owned in one place instead of being restated.
            const metadata = parseTypeDefinitionMetadata(row)
            if (metadata === null) continue
            const name = metadata.label.trim()
            if (name === '') continue
            if (isGrammarShapedLabel(name)) {
              console.warn(
                `[blockTypeNameAliasBackfill] type ${id} left alias-less: its label ` +
                `${JSON.stringify(name)} reads as a block reference, not a name.`,
              )
              continue
            }

            // Deliberately NOT `getAliases` — it degrades a codec error to
            // `[]`, which would turn the append below into a wipe of entries
            // the `block_aliases` trigger still indexes.
            let aliases: readonly string[]
            try {
              const encoded = row.properties[aliasesProp.name]
              aliases = encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
            } catch {
              console.warn(
                `[blockTypeNameAliasBackfill] type ${id} ("${name}") left alias-less: ` +
                `its stored alias list is malformed, and appending would drop the ` +
                `entries still indexed for it.`,
              )
              continue
            }
            if (aliases.includes(name)) continue

            // Preflight EVERY entry the write will re-insert, not just `name`.
            // `blocks_alias_update` deletes and re-inserts the row's WHOLE alias
            // list, so a latent cross-client duplicate on one of its EXISTING
            // aliases aborts a claim we never asked for. Catching that abort is
            // not sufficient: in a `properties_migration = 'children'` workspace
            // `setProperty` writes the value children first and the parent-bag
            // collision is raised later, by the children projection, OUTSIDE any
            // try/catch here — taking the whole batch (and the marker) with it.
            // Preflighting is the only form that holds in both storage modes.
            //
            // `aliasClaimants` sees this tx's own writes, so two same-named
            // types in one batch resolve here (the second is skipped) rather
            // than tripping the uniqueness trigger. Self is a legitimate
            // claimant of the row's existing aliases, hence `!== id`.
            const contested: string[] = []
            for (const alias of [...aliases, name]) {
              const rivals = (await t.aliasClaimants(alias, workspaceId))
                .filter(claimant => claimant.id !== id)
              if (rivals.length > 0) {
                contested.push(`${JSON.stringify(alias)} (claimed by ${rivals.map(r => r.id).join(', ')})`)
              }
            }
            if (contested.length > 0) {
              console.warn(
                `[blockTypeNameAliasBackfill] type ${id} ("${name}") left alias-less: ` +
                `${contested.join('; ')} in workspace ${workspaceId}. This pass is ` +
                `one-shot per workspace, so freeing the name later will NOT re-claim it ` +
                `— rename the type via the type editor, or add the alias to it by hand.`,
              )
              continue
            }

            try {
              // `skipMetadata`: deferred machine maintenance, not a user edit.
              // Without it every migrated type is stamped `user_updated_at = now`
              // + `updated_by = <current user>`, and `core.recentBlocks` sorts on
              // exactly that — Recents would fill with type pages "edited" the
              // moment the backfill ran, burying the user's real work.
              await t.setProperty(id, aliasesProp, [...aliases, name], {skipMetadata: true})
            } catch (err) {
              // Defence in depth only — the preflight above is what actually
              // prevents this, and no test can reach here through the public
              // path. Left in for the race the preflight can't close (a
              // sync-applied co-claim landing between preflight and write).
              if (parseAliasCollisionError(err) === null) throw err
              console.warn(
                `[blockTypeNameAliasBackfill] type ${id} ("${name}") left alias-less: ` +
                `an alias collision landed between the preflight and the write.`,
              )
            }
          }
        },
        {scope: ChangeScope.BlockDefault, description: 'backfill block-type name alias'},
      )
    }
  },
}
