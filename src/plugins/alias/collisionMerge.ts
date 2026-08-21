import { z } from 'zod'
import {
  ChangeScope,
  defineMutator,
  type BlockData,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { mergeBlocksInTx } from '@/data/blockMerge'
import { mergeProperties } from '@/data/mergeProperties'

export const ALIAS_COLLISION_MERGE_MUTATOR = 'alias.mergeCollision'

interface AliasCollisionMergeArgs {
  intoId: string
  fromId: string
  collisionAlias: string
  dropSourceAliases?: string[]
  /** Which way round this merge is, because the two directions have opposite
   *  premises about `from`.
   *
   *  Default (`false`) is the rejection toast: `from` is the block whose claim
   *  was just REJECTED, so it does NOT hold `collisionAlias`, and it is being
   *  renamed — discarding its old title is what the user asked for.
   *
   *  `true` is the duplicate-name banner: `from` is the current OWNER of the
   *  alias and the canonical page is reclaiming it. Here `from` must still hold
   *  the alias, and its title is the name the user knows it by, so it survives
   *  as an alias rather than being dropped on the floor. */
  sourceIsAliasOwner?: boolean
}

const aliasCollisionMergeArgsSchema = z.object({
  intoId: z.string(),
  fromId: z.string(),
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

const collisionAwarePropertyMerge = (
  into: BlockData,
  from: BlockData,
  dropSourceAliases: readonly string[],
  keepSourceTitle: boolean,
): Record<string, unknown> => {
  const merged = mergeProperties(into.properties, from.properties)
  const drop = new Set(dropSourceAliases)
  const intoAliases = decodeAliases(into)
  const keptFromAliases = decodeAliases(from).filter(alias => !drop.has(alias))
  // When the source OWNED the alias, its title rides along as an alias:
  // `contentStrategy: 'keepTarget'` discards the source's content, and in that
  // direction the content is the name the user knows the page by — a page
  // called "Daily Log" aliased "Journal" would otherwise lose "Daily Log"
  // entirely, with nothing left pointing at it. Matches what the A3 drift-heal
  // rule would have done had the content changed instead. Not done in the
  // rejection direction, where the source is mid-rename and dropping its old
  // title is the point.
  const fromTitle = from.content.trim()
  const keepTitle = keepSourceTitle && fromTitle !== '' && !drop.has(fromTitle)
  // Title goes LAST: the first entry reads as the page's primary name, and
  // that should stay the canonical one, not the absorbed page's.
  merged[aliasesProp.name] = aliasesProp.codec.encode(union([
    ...intoAliases,
    ...keptFromAliases,
    ...(keepTitle ? [fromTitle] : []),
  ]))
  return merged
}

export const aliasCollisionMerge = defineMutator<AliasCollisionMergeArgs, void>({
  name: ALIAS_COLLISION_MERGE_MUTATOR,
  argsSchema: aliasCollisionMergeArgsSchema,
  scope: ChangeScope.BlockDefault,
  describe: ({fromId, intoId}) => `merge alias collision ${fromId} → ${intoId}`,
  apply: async (tx, {
    intoId, fromId, collisionAlias, dropSourceAliases = [], sourceIsAliasOwner = false,
  }) => {
    const into = await tx.get(intoId)
    const from = await tx.get(fromId)
    if (into === null) throw new Error(`alias.mergeCollision: target ${intoId} not found`)
    if (from === null) throw new Error(`alias.mergeCollision: source ${fromId} not found`)
    // Re-check the premise here rather than trusting the caller's snapshot: a
    // banner can sit on screen while the world moves, and this mutator is
    // exported, so an extension can call it with anything. Folding a page that
    // does not hold the alias would tombstone it and re-home its children for
    // no reason.
    if (sourceIsAliasOwner && !decodeAliases(from).includes(collisionAlias)) {
      throw new Error(
        `alias.mergeCollision: ${fromId} no longer claims "${collisionAlias}"`,
      )
    }

    await mergeBlocksInTx(tx, {
      into,
      from,
      contentStrategy: 'keepTarget',
      mergeProperties: (intoProps, fromProps) =>
        collisionAwarePropertyMerge(
          {...into, properties: intoProps},
          {...from, properties: fromProps},
          dropSourceAliases,
          sourceIsAliasOwner,
        ),
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
