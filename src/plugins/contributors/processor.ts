import {ChangeScope, defineSameTxProcessor, type BlockData, type ChangedRow, type SameTxCtx} from '@/data/api'
import {isFieldValueChild, isPropertyFieldInstance} from '@/data/propertyChildren'
import {jsonValuesEqual} from '@/data/internals/jsonCanonical'
import {PAGE_TYPE} from '@/data/blockTypes'
import {hasBlockType} from '@/data/properties'
import {assertContributor, ensureHumanContributor} from './profiles'
import {attributionCreatorsProp, attributionEditorsProp} from './schema'

declare module '@/data/api/tx' {
  interface TransactionContext {
    contributorId?: string | null
  }
}

const attributionNames = new Set([attributionCreatorsProp.name, attributionEditorsProp.name])

const meaningfulChange = ({before, after}: ChangedRow): boolean => {
  if (!after) return false
  if (after.deleted) return before !== null && !before.deleted
  // Alias resolution creates visible pages with the speculative-mint stamp.
  if (after.updatedAt === 0 && !hasBlockType(after, PAGE_TYPE)) return false
  if (!before || before.content !== after.content) return true
  const keys = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])
  return [...keys].some(name => !attributionNames.has(name)
    && !jsonValuesEqual(before.properties[name], after.properties[name]))
}

const targetOf = async (row: BlockData, ctx: SameTxCtx): Promise<string | undefined> => {
  const field = (candidate: BlockData | null) => isPropertyFieldInstance(candidate,
    id => ctx.resolvePropertySchemaField(row.workspaceId, id).status === 'resolved')
  const ownerOf = (candidate: BlockData) => {
    const resolved = ctx.resolvePropertySchemaField(row.workspaceId, candidate.referenceTargetId!)
    return resolved.status === 'resolved' && !attributionNames.has(resolved.schema.name)
      ? candidate.parentId ?? undefined : undefined
  }
  if (field(row)) return ownerOf(row)
  if (row.parentId && isFieldValueChild(row)) {
    const parent = await ctx.tx.get(row.parentId)
    if (parent && field(parent)) return ownerOf(parent)
  }
  return row.id
}

export const contributorAttributionProcessor = defineSameTxProcessor({
  name: 'contributors.recordAttribution',
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'properties', 'deleted']},
  apply: async (event, ctx) => {
    if (event.scope !== ChangeScope.BlockDefault) return
    const targets = new Map<string, boolean>()
    for (const change of event.changedRows) {
      if (!ctx.hasUserWrite(change.id)) continue
      if (change.before && change.after && !change.after.deleted) {
        for (const prop of [attributionCreatorsProp, attributionEditorsProp]) {
          const previous = change.before.properties[prop.name]
          if (previous !== undefined && change.after.properties[prop.name] === undefined) {
            await ctx.tx.setProperty(change.id, prop, prop.codec.decode(previous), {skipMetadata: true})
          }
        }
      }
      if (!meaningfulChange(change)) continue
      const target = await targetOf(change.after!, ctx)
      if (change.after!.deleted && target === change.id) continue
      if (target) targets.set(target, targets.get(target) === true || (target === change.id && change.before === null))
    }
    if (targets.size === 0 || ctx.tx.meta.context?.contributorId === null) return
    const contributorId = ctx.tx.meta.context?.contributorId
      ?? await ensureHumanContributor(ctx.tx, event.workspaceId, event.user, {types: ctx.types, propertySchemas: ctx.propertySchemas})
    await assertContributor(ctx.tx, contributorId, event.workspaceId)
    for (const [id, created] of targets) {
      const row = await ctx.tx.get(id)
      if (!row || row.deleted) continue
      const prop = created ? attributionCreatorsProp : attributionEditorsProp
      await ctx.tx.setProperty(id, prop, current => [...new Set([...(current ?? []), contributorId])], {skipMetadata: true})
    }
  },
})
