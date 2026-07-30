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
 * Deliberately narrow — it runs against live graphs:
 *   - **additive only.** It appends the type's name to whatever alias list
 *     the block already has; it never removes, reorders, or rewrites an
 *     existing entry, and never touches `content` or the type's label.
 *   - **never steals a claim.** `tx.aliasClaimants` (not `aliasLookup` —
 *     sync-applied rows can land co-claimants that the `LIMIT 1` form hides)
 *     is checked inside the tx; any live claimant that isn't this block
 *     means the row is skipped and logged. A duplicate-named legacy type,
 *     or a real page that already owns the name, keeps what it has. Merging
 *     the two is a user decision, not a backfill's.
 *   - **skips seed-owned rows,** exactly as the typeify processor does:
 *     `materializeTypeSeeds` mints code-authored `block-type` blocks at
 *     deterministic `/type/` ids, and those were never pages. This one isn't
 *     merely cosmetic — `structuralEditPolicy` REFUSES any edit to a seed
 *     definition block ("its bag is code-owned") by throwing, so a single
 *     un-skipped seed row would abort the whole run and, with no marker
 *     recorded, keep aborting it on every open.
 *   - **skips label-less rows.** An empty `block-type:label` makes
 *     `tryBuildType` drop the block, so it isn't a named type yet; naming it
 *     later goes through `writeBlockTypeLabel`, which seeds the alias then.
 *
 * Because the claim is written through `repo.tx`, the kernel
 * `core.aliasClaimRederive` post-commit hook fires for every gained alias and
 * re-derives the `[[X]]` rows that stamped NULL while nothing claimed X — so
 * pre-existing references start resolving to the type without a reload. The
 * writes carry `source = 'user'` (the whole point of a `WorkspaceBackfill`
 * over a raw `db.execute`), so they upload and every other client converges.
 */

import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { seededDefinitionKey } from '@/data/definitionSeeds'
import type { WorkspaceBackfill } from '@/data/facets'
import { aliasesProp, blockTypeLabelProp, getAliases } from '@/data/properties'
import { isTypeSeedKey } from '@/data/typeSeeds'

/** Candidate rows: every live `block-type`-tagged block in this workspace.
 *  The interesting predicates (seed-owned, label empty, alias already
 *  present, alias claimed elsewhere) are all re-checked per row inside the
 *  tx against the same helpers the write paths use — a JSON-shape guess in
 *  SQL would drift from `getAliases`' codec. Types number in the dozens, so
 *  the loose scan costs nothing. */
const SELECT_BLOCK_TYPE_BLOCKS_SQL = `
  SELECT b.id AS id
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${BLOCK_TYPE_TYPE}'
  WHERE b.workspace_id = ?
    AND b.deleted = 0
`

/** Tx batch size. Small because the candidate set is small; batching mainly
 *  buys partial progress across a mid-run failure (the marker is recorded
 *  only after every batch commits, and the per-row rechecks make a re-scan
 *  cheap and idempotent). */
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
            // Re-check everything inside the tx: a sync-applied delete, move,
            // or alias claim can land between the SELECT and here.
            if (!row || row.deleted) continue
            if (row.workspaceId !== workspaceId) continue

            const seedKey = seededDefinitionKey(row)
            if (seedKey !== undefined && isTypeSeedKey(seedKey)) continue

            const rawLabel = row.properties[blockTypeLabelProp.name]
            const name = (typeof rawLabel === 'string' ? rawLabel : '').trim()
            if (name === '') continue

            const aliases = getAliases(row)
            if (aliases.includes(name)) continue

            // Sees this tx's own writes, so two same-named types in one batch
            // resolve here (the second is skipped) rather than tripping the
            // `block_aliases_workspace_alias_unique` trigger and rolling the
            // whole batch back.
            const claimants = await t.aliasClaimants(name, workspaceId)
            if (claimants.some(claimant => claimant.id !== id)) {
              console.warn(
                `[blockTypeNameAliasBackfill] type ${id} ("${name}") left alias-less: ` +
                `${claimants.map(c => c.id).join(', ')} already claim(s) that name in ` +
                `workspace ${workspaceId}. Rename either side to let [[${name}]] resolve ` +
                `to the type.`,
              )
              continue
            }

            await t.setProperty(id, aliasesProp, [...aliases, name])
          }
        },
        {scope: ChangeScope.BlockDefault, description: 'backfill block-type name alias'},
      )
    }
  },
}
