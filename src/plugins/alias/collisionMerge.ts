import { z } from 'zod'
import {
  ChangeScope,
  defineMutator,
  type BlockData,
  type Tx,
} from '@/data/api'
import { aliasesProp, getAliases } from '@/data/properties'
import { foldBlocksInTx } from '@/data/blockMerge'
import { mergeProperties } from '@/data/mergeProperties'

export const ALIAS_COLLISION_MERGE_MUTATOR = 'alias.mergeCollision'

/** A name the survivor would end up holding is claimed by a page this merge is
 *  not folding in.
 *
 *  Refused up front rather than left to the uniqueness trigger, because the
 *  trigger's ABORT is not a dead end you can retry out of — it surfaces as
 *  `alias.collision` naming the SURVIVOR as the offender, and the rejection
 *  toast then offers a merge in the opposite direction, which tombstones the
 *  page the user was trying to repair. */
export class AliasMergeBlockedError extends Error {
  constructor(readonly alias: string, readonly blockerId: string) {
    super(`alias.mergeCollision: "${alias}" is claimed by ${blockerId}, which this merge does not fold in`)
    this.name = 'AliasMergeBlockedError'
  }
}

interface AliasCollisionMergeArgs {
  intoId: string
  /** Every block to fold in, in one transaction. Plural because an alias can
   *  have several live claimants — the uniqueness trigger skips sync-apply, so
   *  two devices creating the same page offline both keep their claim. Folding
   *  them one call at a time cannot work: the survivor's write claims the name
   *  while a claimant still holds it, so the trigger rolls the whole thing
   *  back, identically, every retry. */
  fromIds: string[]
  collisionAlias: string
  dropSourceAliases?: string[]
  /** Which way round this merge is, because the two directions have opposite
   *  premises about the sources.
   *
   *  Default (`false`) is the rejection toast: the source is the block whose
   *  claim was just REJECTED, so it does NOT hold `collisionAlias`, and it is
   *  being renamed — discarding its old title is what the user asked for.
   *
   *  `true` is the duplicate-name banner: the sources are the current OWNERS of
   *  the alias and the canonical page is reclaiming it. Here each source must
   *  still hold the alias, and its title is the name the user knows it by, so
   *  it survives as an alias rather than being dropped on the floor. */
  sourceIsAliasOwner?: boolean
}

const aliasCollisionMergeArgsSchema = z.object({
  intoId: z.string(),
  fromIds: z.array(z.string()),
  collisionAlias: z.string(),
  dropSourceAliases: z.array(z.string()).optional(),
  sourceIsAliasOwner: z.boolean().optional(),
})

const union = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Which sources' titles are free to carry over as aliases.
 *
 *  When a source OWNED the alias, its title rides along: `contentStrategy:
 *  'keepTarget'` discards the source's content, and in that direction the
 *  content is the name the user knows the page by — a page called "Daily Log"
 *  aliased "Journal" would otherwise lose "Daily Log" entirely, with nothing
 *  left pointing at it. Matches what the A3 drift-heal rule would have done had
 *  the content changed instead. Not done in the rejection direction, where the
 *  source is mid-rename and dropping its old title is the point.
 *
 *  Only if the name is actually FREE, though. A page can hold a title that is
 *  not among its own aliases (alias sync skips freshly inserted rows), and if
 *  another page owns that name, adding it here trips the uniqueness trigger and
 *  rolls back the whole merge — which would make the collision this flow exists
 *  to resolve permanently unresolvable.
 *
 *  Unowned is the whole test, even though a PARTICIPANT's claim is released by
 *  this same transaction and would be safe to take. Exempting participants adds
 *  no name: when one of them owns the title, `mergedAliases` already carries it
 *  — out of the survivor's own bag, or out of that source's aliases. Anything
 *  that stops the survivor's bag being a union over every participant has to
 *  revisit this. */
const claimableTitles = async (
  tx: Tx,
  into: BlockData,
  sources: readonly BlockData[],
  drop: ReadonlySet<string>,
): Promise<Set<string>> => {
  const claimable = new Set<string>()
  for (const source of sources) {
    const title = source.content
    if (title.trim() === '' || drop.has(title)) continue
    if (await tx.aliasLookup(title, into.workspaceId) === null) claimable.add(source.id)
  }
  return claimable
}

/** The survivor's final alias bag. Precomputed from every participant rather
 *  than accumulated fold-by-fold, because the answer does not depend on the
 *  order the sources are folded in and the bag is written once, at the end. */
const mergedAliases = (
  into: BlockData,
  collisionAlias: string,
  sources: readonly BlockData[],
  drop: ReadonlySet<string>,
  keepTitles: ReadonlySet<string>,
): string[] => union([
  ...getAliases(into),
  // Stated outright rather than left to arrive via a source's bag. The whole
  // point of the reclaim direction is that the survivor ends up holding this
  // name, and `getAliases` returns [] for a bag it cannot decode — while the
  // alias TRIGGER indexes any `typeof 'text'` entry, so a sync-applied
  // `["Journal", 7]` is a real claimant whose claim would otherwise be
  // released by the fold and picked up by nobody. In the rejection direction
  // `into` already holds it and this dedupes away.
  collisionAlias,
  ...sources.flatMap(source => [
    ...getAliases(source).filter(alias => !drop.has(alias)),
    // A title goes after its own page's aliases, and every source after the
    // survivor's: the first entry reads as the page's primary name, and that
    // should stay the canonical one rather than an absorbed page's.
    ...(keepTitles.has(source.id) ? [source.content] : []),
  ]),
])

/** Refuse if any name the survivor would end up holding is claimed by a live
 *  page outside the merge.
 *
 *  Releasing every source before the survivor's write covers names the SOURCES
 *  hold — it does nothing about a third page co-claiming one of them, which is
 *  the same latent duplicate state this whole flow exists for. The survivor's
 *  own bag is checked too: it is re-inserted wholesale by the alias trigger on
 *  any properties write, so a name IT co-claims aborts just as hard. */
const assertNoOutsideClaimant = async (
  tx: Tx,
  into: BlockData,
  sources: readonly BlockData[],
  merged: readonly string[],
): Promise<void> => {
  const participants = new Set([into.id, ...sources.map(source => source.id)])
  for (const alias of merged) {
    for (const owner of await tx.aliasClaimants(alias, into.workspaceId)) {
      if (!participants.has(owner.id)) throw new AliasMergeBlockedError(alias, owner.id)
    }
  }
}

export const aliasCollisionMerge = defineMutator<AliasCollisionMergeArgs, void>({
  name: ALIAS_COLLISION_MERGE_MUTATOR,
  argsSchema: aliasCollisionMergeArgsSchema,
  scope: ChangeScope.BlockDefault,
  describe: ({fromIds, intoId}) => `merge alias collision ${fromIds.join(', ')} → ${intoId}`,
  apply: async (tx, {
    intoId, fromIds, collisionAlias, dropSourceAliases = [], sourceIsAliasOwner = false,
  }) => {
    const into = await tx.get(intoId)
    if (into === null) throw new Error(`alias.mergeCollision: target ${intoId} not found`)
    // Folding into a tombstone is never right, in EITHER direction:
    // `keepTarget` discards the source's content, so the source's page is
    // destroyed and nothing survives it — the target is already gone. Not
    // gated on the direction, because the rejection toast can sit on screen
    // just as long as the banner can, and its target can be deleted meanwhile.
    if (into.deleted) throw new Error(`alias.mergeCollision: target ${intoId} is deleted`)

    // Re-check the premise here rather than trusting the caller's snapshot: a
    // banner can sit on screen while the world moves, and this mutator is
    // exported, so an extension can call it with anything. Folding a page that
    // does not hold the alias would tombstone it and re-home its children for
    // no reason.
    if (sourceIsAliasOwner && into.content !== collisionAlias) {
      throw new Error(
        `alias.mergeCollision: target ${intoId} is no longer named "${collisionAlias}"`,
      )
    }

    // LIVE claimants, read from the same index the banner listed them from.
    // The stored alias bag answers a different question and disagrees in two
    // reachable ways: it survives a soft delete, so a tombstoned rival passes a
    // bag check and would contribute its aliases and title to the survivor
    // without ever being folded; and the trigger indexes any `$.alias` entry
    // that is `typeof 'text'`, while the string-list codec throws on a bag
    // holding anything else — so a sync-applied `["Journal", 7]` is a claimant
    // the banner offers and a bag check refuses forever.
    const claimants = sourceIsAliasOwner
      ? new Set((await tx.aliasClaimants(collisionAlias, into.workspaceId)).map(c => c.id))
      : null

    const sources: BlockData[] = []
    for (const fromId of fromIds) {
      const from = await tx.get(fromId)
      if (from === null) throw new Error(`alias.mergeCollision: source ${fromId} not found`)
      // Source side — folding a page that no longer holds the name would
      // tombstone it and re-home its children for nothing.
      if (claimants !== null && !claimants.has(fromId)) {
        throw new Error(
          `alias.mergeCollision: ${fromId} no longer claims "${collisionAlias}"`,
        )
      }
      // A tombstoned source is a merge that already happened (#188), which
      // `foldBlocksInTx` skips. Drop it HERE too, so the alias set below is
      // computed from the sources actually folded — otherwise the survivor
      // claims a name and title from a page it never absorbed, leaving that
      // page's children under its tombstone and its inbound references pinned
      // there. (Unreachable in the reclaim direction, which the claimant check
      // above already refuses; the rejection direction has no such check.)
      if (from.deleted) continue
      sources.push(from)
    }

    const drop = new Set(dropSourceAliases)
    const keepTitles = sourceIsAliasOwner
      ? await claimableTitles(tx, into, sources, drop)
      : new Set<string>()
    const merged = mergedAliases(into, collisionAlias, sources, drop, keepTitles)
    await assertNoOutsideClaimant(tx, into, sources, merged)
    const finalAliases = aliasesProp.codec.encode(merged)

    await foldBlocksInTx(tx, {
      into,
      froms: sources,
      contentStrategy: 'keepTarget',
      mergeProperties: (intoProps, fromProps) => ({
        ...mergeProperties(intoProps, fromProps),
        [aliasesProp.name]: finalAliases,
      }),
      aliasRewrites: dropSourceAliases.map(fromAlias => ({
        fromAlias,
        toAlias: collisionAlias,
      })),
    })
  },
})

export const aliasCollisionMutators = [aliasCollisionMerge] as const

declare module '@/data/api' {
  interface MutatorRegistry {
    [ALIAS_COLLISION_MERGE_MUTATOR]: typeof aliasCollisionMerge
  }
}
