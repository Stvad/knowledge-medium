import { z } from 'zod'
import {
  ChangeScope,
  defineMutator,
  type BlockData,
  type Tx,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { foldBlocksInTx } from '@/data/blockMerge'
import { mergeProperties } from '@/data/mergeProperties'

export const ALIAS_COLLISION_MERGE_MUTATOR = 'alias.mergeCollision'

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

const decodeAliases = (block: BlockData): string[] => {
  const encoded = block.properties[aliasesProp.name]
  if (encoded === undefined) return []
  try {
    return aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

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
 *  some THIRD page owns that name, adding it here trips the uniqueness trigger
 *  and rolls back the whole merge — which would make the collision this flow
 *  exists to resolve permanently unresolvable. A participant holding it is not
 *  a third page: every source is tombstoned by this same transaction, so its
 *  claim is released before the survivor's bag is written. */
const claimableTitles = async (
  tx: Tx,
  into: BlockData,
  sources: readonly BlockData[],
  drop: ReadonlySet<string>,
): Promise<Set<string>> => {
  const participants = new Set([into.id, ...sources.map(source => source.id)])
  const claimable = new Set<string>()
  for (const source of sources) {
    const title = source.content
    if (title.trim() === '' || drop.has(title)) continue
    const owner = await tx.aliasLookup(title, into.workspaceId)
    if (owner === null || participants.has(owner.id)) claimable.add(source.id)
  }
  return claimable
}

/** The survivor's final alias bag. Precomputed from every participant rather
 *  than accumulated fold-by-fold, because the answer does not depend on the
 *  order the sources are folded in and the bag is written once, at the end. */
const mergedAliases = (
  into: BlockData,
  sources: readonly BlockData[],
  drop: ReadonlySet<string>,
  keepTitles: ReadonlySet<string>,
): string[] => union([
  ...decodeAliases(into),
  ...sources.flatMap(source => [
    ...decodeAliases(source).filter(alias => !drop.has(alias)),
    // A title goes after its own page's aliases, and every source after the
    // survivor's: the first entry reads as the page's primary name, and that
    // should stay the canonical one rather than an absorbed page's.
    ...(keepTitles.has(source.id) ? [source.content] : []),
  ]),
])

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

    // Re-check the premise here rather than trusting the caller's snapshot: a
    // banner can sit on screen while the world moves, and this mutator is
    // exported, so an extension can call it with anything. Folding a page that
    // does not hold the alias would tombstone it and re-home its children for
    // no reason.
    if (sourceIsAliasOwner) {
      // Target side — if the page doing the reclaiming was deleted or renamed
      // in the meantime, the alias owner would be absorbed into something that
      // is no longer the page the user was looking at.
      if (into.deleted) {
        throw new Error(`alias.mergeCollision: target ${intoId} is deleted`)
      }
      if (into.content !== collisionAlias) {
        throw new Error(
          `alias.mergeCollision: target ${intoId} is no longer named "${collisionAlias}"`,
        )
      }
    }

    const sources: BlockData[] = []
    for (const fromId of fromIds) {
      const from = await tx.get(fromId)
      if (from === null) throw new Error(`alias.mergeCollision: source ${fromId} not found`)
      // Source side — folding a page that no longer holds the name would
      // tombstone it and re-home its children for nothing.
      if (sourceIsAliasOwner && !decodeAliases(from).includes(collisionAlias)) {
        throw new Error(
          `alias.mergeCollision: ${fromId} no longer claims "${collisionAlias}"`,
        )
      }
      sources.push(from)
    }

    const drop = new Set(dropSourceAliases)
    const keepTitles = sourceIsAliasOwner
      ? await claimableTitles(tx, into, sources, drop)
      : new Set<string>()
    const finalAliases = aliasesProp.codec.encode(
      mergedAliases(into, sources, drop, keepTitles),
    )

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
