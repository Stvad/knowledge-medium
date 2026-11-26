import { ChangeScope, type AnyPropertySchema, type BlockData } from '@/data/api'
import { takesTextEdit } from '@/data/blockTypes'
import { hasBlockType } from '@/data/properties'
import { isFieldValueChild, isPropertyFieldInstance, readRefValue } from '@/data/propertyChildren'
import type { Repo } from '@/data/repo'
import type { BlockDateAdapter } from './blockDateAdapter'
import { dailyNoteIsoFromRow } from './dailyNotes'
import { writeDayReferenceValue } from './referenceDateAdapter'
import { DAILY_NOTE_TYPE, isDayReferenceSchema } from './schema'

type Row = BlockData | null | undefined

export const dayValueReferenceCandidate = (row: Row) => {
  if (!takesTextEdit(row) || row.parentId === null || !isFieldValueChild(row)) return null
  const reference = readRefValue(row.content, row.referenceTargetId)
  return reference.kind === 'id'
    ? {workspaceId: row.workspaceId, parentId: row.parentId, targetId: reference.id}
    : null
}

const dayField = (field: Row, workspaceId: string, resolve: (fieldId: string) => AnyPropertySchema | null) => {
  if (!field || field.deleted || field.workspaceId !== workspaceId || !isPropertyFieldInstance(field, () => true)) return null
  const schema = resolve(field.referenceTargetId!)
  return schema && isDayReferenceSchema(schema) ? {schema, ownerId: field.parentId!} : null
}

export const dayReferenceTargetIso = (row: Row, workspaceId: string) =>
  row && !row.deleted && row.workspaceId === workspaceId && hasBlockType(row, DAILY_NOTE_TYPE)
    ? dailyNoteIsoFromRow(row)
    : null

const dayValueReferenceIso = (repo: Repo, workspaceId: string, field: Row, target: Row): string | null => {
  const resolved = dayField(field, workspaceId, id => {
    const resolution = repo.propertySchemaResolverFor(workspaceId).resolveField(id)
    return resolution.status === 'resolved' ? resolution.schema : null
  })
  return resolved ? dayReferenceTargetIso(target, workspaceId) : null
}

export const dayValueReferenceAdapter: BlockDateAdapter = {
  id: 'daily-notes.day-value-reference',
  canHandle: block => {
    const candidate = dayValueReferenceCandidate(block.peek())
    if (!candidate) return false
    const {workspaceId, parentId, targetId} = candidate
    const {repo} = block
    return dayValueReferenceIso(repo, workspaceId, repo.block(parentId).peek(), repo.block(targetId).peek()) !== null
  },
  getCurrentIso: async block => {
    const candidate = dayValueReferenceCandidate(block.peek() ?? await block.load())
    if (!candidate) return null
    const {repo} = block
    const {workspaceId, parentId, targetId} = candidate
    const field = repo.block(parentId)
    const target = repo.block(targetId)
    const [fieldRow, targetRow] = await Promise.all([field.peek() ?? field.load(), target.peek() ?? target.load()])
    return dayValueReferenceIso(repo, workspaceId, fieldRow, targetRow)
  },
  setIso: async (block, iso) => {
    if (block.repo.isReadOnly) return false
    return block.repo.tx(async tx => {
      const candidate = dayValueReferenceCandidate(await tx.get(block.id))
      if (!candidate) return false
      const {workspaceId, parentId, targetId} = candidate
      const field = dayField(await tx.get(parentId), workspaceId, id => tx.resolvePropertyFieldSchema(workspaceId, id))
      if (!field) return false
      const owner = await tx.get(field.ownerId)
      if (!owner || owner.deleted || owner.workspaceId !== workspaceId) return false
      const current = dayReferenceTargetIso(await tx.get(targetId), workspaceId)
      if (!current || current === iso) return false
      await writeDayReferenceValue(block, tx, {id: block.id, workspaceId}, field.schema, iso)
      return true
    }, {scope: ChangeScope.BlockDefault, description: 'set day reference'})
  },
}
