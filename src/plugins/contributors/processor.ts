import {ChangeScope, defineSameTxProcessor, type BlockData, type ChangedRow, type SameTxCtx} from '@/data/api'
import {isFieldValueChild, isPropertyFieldInstance} from '@/data/propertyChildren'
import {jsonValuesEqual} from '@/data/internals/jsonCanonical'
import {PAGE_TYPE} from '@/data/blockTypes'
import {hasBlockType} from '@/data/properties'
import {assertContributor, ensureHumanContributor} from './profiles'
import {attributionCreatorsProp, attributionEditorsProp, contributorKindProp} from './schema'

declare module '@/data/api/tx' {
  interface TransactionContext {
    contributorId?: string | null
    contributorSource?: 'agent'
  }
}

const attributionNames = new Set([attributionCreatorsProp.name, attributionEditorsProp.name])
const authoredFields = ['content', 'properties', 'deleted', 'parentId', 'orderKey'] as const

const meaningfulChange = ({before, after}: ChangedRow): boolean => {
  if (!after) return false
  // Alias resolution creates visible pages with the speculative-mint stamp.
  if (after.updatedAt === 0 && !hasBlockType(after, PAGE_TYPE)) return false
  if (!before || authoredFields.some(field => field !== 'properties' && before[field] !== after[field])) return true
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

const hasNonHumanAttribution = async (row: BlockData, ctx: SameTxCtx): Promise<boolean> => {
  for (const prop of [attributionCreatorsProp, attributionEditorsProp]) {
    for (const id of prop.codec.decode(row.properties[prop.name] ?? [])) {
      const profile = await ctx.tx.get(id)
      if (contributorKindProp.codec.decode(profile?.properties[contributorKindProp.name] ?? 'agent') !== 'human') return true
    }
  }
  return false
}

export const contributorAttributionProcessor = defineSameTxProcessor({
  name: 'contributors.recordAttribution',
  watches: {kind: 'field', table: 'blocks', fields: authoredFields},
  apply: async (event, ctx) => {
    if (event.scope !== ChangeScope.BlockDefault) return
    const targets = new Map<string, boolean>()
    for (const change of event.changedRows) {
      if (!ctx.hasUserWrite(change.id)) continue
      if (change.before && change.after && !change.after.deleted) {
        for (const prop of [attributionCreatorsProp, attributionEditorsProp]) {
          const previous = change.before.properties[prop.name]
          if (previous !== undefined && change.after.properties[prop.name] === undefined
            && !ctx.wasPropertyUnset(change.id, prop.name)) {
            await ctx.tx.setProperty(change.id, prop, prop.codec.decode(previous), {skipMetadata: true})
          }
        }
      }
      if (!meaningfulChange(change)) continue
      const target = await targetOf(change.after!, ctx)
      if (target) targets.set(target, targets.get(target) === true || (target === change.id && change.before === null))
    }
    if (targets.size === 0 || ctx.tx.meta.context?.contributorId === null) return
    const context = ctx.tx.meta.context
    const selectedId = context?.contributorId ?? undefined
    const selected = selectedId ? await ctx.tx.get(selectedId) : null
    const human = context?.contributorSource !== 'agent' && (selectedId === undefined
      || contributorKindProp.codec.decode(selected?.properties[contributorKindProp.name] ?? 'agent') === 'human')
    const eligible: Array<[string, boolean]> = []
    for (const [id, created] of targets) {
      const row = await ctx.tx.get(id)
      if (!row || row.deleted) continue
      if (human && !await hasNonHumanAttribution(row, ctx)) continue
      eligible.push([id, created])
    }
    if (eligible.length === 0 && context?.contributorSource !== 'agent') return
    if (context?.contributorSource === 'agent' && selectedId === undefined) {
      throw new Error('Choose a contributor before writing: run contributor create <name> or contributor use <id>; --contributor none opts out. A current CLI or MCP with contributor support is required; upgrade @knowledge-medium/agent-cli or use this checkout\'s pnpm agent.')
    }
    const snapshot = {types: ctx.types, propertySchemas: ctx.propertySchemas}
    const contributorId = selectedId ?? await ensureHumanContributor(ctx.tx, event.workspaceId, event.user, snapshot)
    await assertContributor(ctx.tx, contributorId, event.workspaceId, {allowHuman: context?.contributorSource !== 'agent'})
    for (const [id, created] of eligible) {
      const prop = created ? attributionCreatorsProp : attributionEditorsProp
      await ctx.tx.setProperty(id, prop, current => [...new Set([...(current ?? []), contributorId])], {skipMetadata: true})
    }
  },
})
