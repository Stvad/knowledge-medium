import {ChangeScope, defineSameTxProcessor, type BlockData, type ChangedRow, type SameTxCtx} from '@/data/api'
import {isFieldValueChild, isPropertyFieldInstance} from '@/data/propertyChildren'
import {jsonValuesEqual} from '@/data/internals/jsonCanonical'
import {PAGE_TYPE} from '@/data/blockTypes'
import {hasBlockType} from '@/data/properties'
import {assertContributor, ensureHumanContributor} from './profiles'
import {attributionCreatorsProp, attributionEditorsProp, contributorKindOf} from './schema'

declare module '@/data/api/tx' {
  interface TransactionContext {
    contributorId?: string | null
    contributorSource?: 'agent'
  }
}

const attributionProps = [attributionCreatorsProp, attributionEditorsProp] as const
type AttributionProperty = typeof attributionProps[number]
const attributionNames = new Set(attributionProps.map(prop => prop.name))
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

const targetOf = async (row: BlockData, ctx: SameTxCtx): Promise<{id: string; attribution?: AttributionProperty} | undefined> => {
  const field = (candidate: BlockData | null) => isPropertyFieldInstance(candidate,
    id => ctx.resolvePropertySchemaField(row.workspaceId, id).status === 'resolved')
  const ownerOf = (candidate: BlockData) => {
    const resolved = ctx.resolvePropertySchemaField(row.workspaceId, candidate.referenceTargetId!)
    return resolved.status === 'resolved' && candidate.parentId
      ? {id: candidate.parentId, attribution: attributionProps.find(prop => prop.name === resolved.schema.name)}
      : undefined
  }
  if (field(row)) return ownerOf(row)
  if (row.parentId && isFieldValueChild(row)) {
    const parent = await ctx.tx.get(row.parentId)
    if (parent && field(parent)) return ownerOf(parent)
  }
  return {id: row.id}
}

const hasNonHumanAttribution = async (row: BlockData, ctx: SameTxCtx): Promise<boolean> => {
  for (const prop of [attributionCreatorsProp, attributionEditorsProp]) {
    for (const id of prop.codec.decode(row.properties[prop.name] ?? [])) {
      const profile = await ctx.tx.get(id)
      if (contributorKindOf(profile) !== 'human') return true
    }
  }
  return false
}

export const contributorAttributionProcessor = defineSameTxProcessor({
  name: 'contributors.recordAttribution',
  watches: {kind: 'field', table: 'blocks', fields: authoredFields},
  apply: async (event, ctx) => {
    if (event.scope !== ChangeScope.BlockDefault) return
    const targets = new Map<string, {created: boolean; authored: boolean; corrections: Set<AttributionProperty>}>()
    for (const change of event.changedRows) {
      if (!ctx.hasUserWrite(change.id)) continue
      if (change.before && change.after && !change.after.deleted) {
        for (const prop of attributionProps) {
          const previous = change.before.properties[prop.name]
          if (previous !== undefined && change.after.properties[prop.name] === undefined
            && !ctx.wasPropertyUnset(change.id, prop.name)) {
            await ctx.tx.setProperty(change.id, prop, prop.codec.decode(previous), {skipMetadata: true})
          }
        }
      }
      const authored = meaningfulChange(change)
      const corrections = attributionProps.filter(prop =>
        !jsonValuesEqual(change.before?.properties[prop.name], change.after?.properties[prop.name])
        && (change.after?.properties[prop.name] !== undefined || ctx.wasPropertyUnset(change.id, prop.name)))
      if (!authored && corrections.length === 0) continue
      const target = await targetOf(change.after!, ctx)
      if (!target) continue
      const entry = targets.get(target.id) ?? {created: false, authored: false, corrections: new Set<AttributionProperty>()}
      if (target.attribution) entry.corrections.add(target.attribution)
      else {
        entry.authored ||= authored
        entry.created ||= target.id === change.id && change.before === null
        for (const prop of corrections) entry.corrections.add(prop)
      }
      targets.set(target.id, entry)
    }
    if (targets.size === 0) return
    const context = ctx.tx.meta.context
    const selectedId = context?.contributorId ?? undefined
    const external = context?.contributorSource === 'agent'
    if (external) {
      if (context.contributorId === undefined) {
        throw new Error('Choose a contributor before writing: run contributor create <name> or contributor use <id>; --contributor none opts out. A current CLI or MCP with contributor support is required; upgrade @knowledge-medium/agent-cli or use this checkout\'s pnpm agent.')
      }
      if (selectedId !== undefined) await assertContributor(ctx.tx, selectedId, event.workspaceId, {allowHuman: false})
      for (const [id, {corrections}] of targets) {
        const row = await ctx.tx.get(id)
        for (const prop of corrections) {
          for (const profileId of prop.codec.decode(row?.properties[prop.name] ?? [])) {
            await assertContributor(ctx.tx, profileId, event.workspaceId, {allowDeleted: true})
          }
        }
      }
    }
    if (context?.contributorId === null) return
    const selected = selectedId ? await ctx.tx.get(selectedId) : null
    const human = !external && (selectedId === undefined
      || contributorKindOf(selected) === 'human')
    const eligible: Array<[string, boolean]> = []
    for (const [id, {created, authored}] of targets) {
      if (!authored) continue
      const row = await ctx.tx.get(id)
      if (!row || row.deleted) continue
      if (human && !await hasNonHumanAttribution(row, ctx)) continue
      eligible.push([id, created])
    }
    if (eligible.length === 0) return
    const snapshot = {types: ctx.types, propertySchemas: ctx.propertySchemas}
    const contributorId = selectedId ?? await ensureHumanContributor(ctx.tx, event.workspaceId, event.user, snapshot)
    if (!external) await assertContributor(ctx.tx, contributorId, event.workspaceId)
    for (const [id, created] of eligible) {
      const prop = created ? attributionCreatorsProp : attributionEditorsProp
      if (targets.get(id)!.corrections.has(prop)) continue
      await ctx.tx.setProperty(id, prop, current => [...new Set([...(current ?? []), contributorId])], {skipMetadata: true})
    }
  },
})
