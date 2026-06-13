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
}

const aliasCollisionMergeArgsSchema = z.object({
  intoId: z.string(),
  fromId: z.string(),
  collisionAlias: z.string(),
  dropSourceAliases: z.array(z.string()).optional(),
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
  collisionAlias: string,
  dropSourceAliases: readonly string[],
): Record<string, unknown> => {
  const merged = mergeProperties(into.properties, from.properties)
  const drop = new Set(dropSourceAliases)
  const intoAliases = decodeAliases(into)
  const keptFromAliases = decodeAliases(from)
    .filter(alias => alias !== collisionAlias && !drop.has(alias))
  merged[aliasesProp.name] = aliasesProp.codec.encode(union([
    ...intoAliases,
    ...keptFromAliases,
  ]))
  return merged
}

export const aliasCollisionMerge = defineMutator<AliasCollisionMergeArgs, void>({
  name: ALIAS_COLLISION_MERGE_MUTATOR,
  argsSchema: aliasCollisionMergeArgsSchema,
  scope: ChangeScope.BlockDefault,
  describe: ({fromId, intoId}) => `merge alias collision ${fromId} → ${intoId}`,
  apply: async (tx, {intoId, fromId, collisionAlias, dropSourceAliases = []}) => {
    const into = await tx.get(intoId)
    const from = await tx.get(fromId)
    if (into === null) throw new Error(`alias.mergeCollision: target ${intoId} not found`)
    if (from === null) throw new Error(`alias.mergeCollision: source ${fromId} not found`)

    await mergeBlocksInTx(tx, {
      into,
      from,
      contentStrategy: 'keepTarget',
      mergeProperties: (intoProps, fromProps) =>
        collisionAwarePropertyMerge(
          {...into, properties: intoProps},
          {...from, properties: fromProps},
          collisionAlias,
          dropSourceAliases,
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
