import { SqliteStorageEngine } from '@/data/storage/sqliteEngine'
import type { PropertyRecord, ReferenceRecord } from '@/data/storage/interfaces'
import { BlockData, BlockProperties, BlockProperty, User } from '@/types'
import { SqliteBlock } from '@/data/sqliteBlock'

const ORDER_PAD = 16

class NullUndoRedoManager {
  transaction<T>(fn: () => T, _options?: unknown): T {
    return fn()
  }

  undo(_scope?: string): void {}
  redo(_scope?: string): void {}
}

function structuredCloneOrJson<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function orderKeyForIndex(index: number): string {
  return (index + 1).toString().padStart(ORDER_PAD, '0')
}

function toPropertyRecord(workspaceId: string, blockId: string, property: BlockProperty): PropertyRecord {
  return {
    workspaceId,
    blockId,
    name: property.name,
    type: property.type as PropertyRecord['type'],
    valueJson: property.value !== undefined ? JSON.stringify(property.value) : null,
    changeScope: property.changeScope ?? null,
  }
}

function toReferenceRecords(
  workspaceId: string,
  blockId: string,
  references: BlockData['references']
): ReferenceRecord[] {
  const now = Date.now()
  return references.map((ref, index) => ({
    workspaceId,
    blockId,
    targetWorkspaceId: workspaceId,
    targetId: ref.id,
    refType: 'text-reference',
    origin: 'text',
    alias: ref.alias,
    spanStart: null,
    spanEnd: null,
    sourcePropertyName: null,
    sourcePropertyPath: '',
    ordinal: index,
    metaJson: null,
    createdAt: now,
    updatedAt: now,
  }))
}

function toBlockProperties(records: PropertyRecord[]): BlockProperties {
  const props: BlockProperties = {}
  for (const record of records) {
    props[record.name] = {
      name: record.name,
      type: record.type as BlockProperty['type'],
      value: record.valueJson ? JSON.parse(record.valueJson) : undefined,
      changeScope: record.changeScope ?? undefined,
    }
  }
  return props
}

export class SqliteRepo {
  private blockCache = new Map<string, SqliteBlock>()
  readonly undoRedoManager = new NullUndoRedoManager()

  constructor(
    readonly storage: SqliteStorageEngine,
    readonly currentUser: User,
    readonly workspaceId: string = 'default'
  ) {}

  find(id: string): SqliteBlock {
    const cached = this.blockCache.get(id)
    if (cached) return cached
    const block = new SqliteBlock(this, id)
    this.blockCache.set(id, block)
    return block
  }

  async create(data: Partial<BlockData>): Promise<SqliteBlock> {
    const snapshot = await this.storage.transaction(this.workspaceId, async () => {
      const now = Date.now()
      const snapshot = await this.storage.blocks.createBlock({
        workspaceId: this.workspaceId,
        id: data.id,
        parentId: data.parentId,
        content: data.content ?? '',
        createTime: data.createTime ?? now,
        updateTime: data.updateTime ?? now,
        createdByUserId: data.createdByUserId ?? this.currentUser.id,
        updatedByUserId: data.updatedByUserId ?? this.currentUser.id,
      })

      if (data.properties) {
        for (const property of Object.values(data.properties)) {
          if (!property) continue
          await this.storage.properties.upsert(toPropertyRecord(this.workspaceId, snapshot.blockId, property))
        }
      }

      if (data.references?.length) {
        await this.storage.references.replaceAll(
          { workspaceId: this.workspaceId, blockId: snapshot.blockId },
          toReferenceRecords(this.workspaceId, snapshot.blockId, data.references)
        )
      }

      return snapshot
    })

    return this.find(snapshot.blockId)
  }

  async listRootBlocks(): Promise<SqliteBlock[]> {
    const snapshots = await this.storage.blocks.listChildren({ workspaceId: this.workspaceId, parentId: null })
    return snapshots.map((snapshot) => this.find(snapshot.blockId))
  }

  async ensureSeedData(): Promise<void> {
    const roots = await this.storage.blocks.listChildren({ workspaceId: this.workspaceId, parentId: null })
    if (roots.length > 0) return
    await this.create({ content: 'Welcome to the SQLite backend POC!' })
  }

  async loadBlockData(id: string): Promise<BlockData | undefined> {
    const snapshot = await this.storage.blocks.getBlock({
      workspaceId: this.workspaceId,
      blockId: id,
    })
    if (!snapshot) return undefined

    const children = await this.storage.blocks.listChildren({ workspaceId: this.workspaceId, parentId: id })
    const properties = await this.storage.properties.list({ workspaceId: this.workspaceId, blockId: id })
    const references = await this.storage.references.listBySource({ workspaceId: this.workspaceId, blockId: id })

    const block: BlockData = {
      id: snapshot.blockId,
      content: snapshot.content,
      properties: toBlockProperties(properties),
      childIds: children.map((child) => child.blockId),
      createTime: snapshot.createTime,
      updateTime: snapshot.updateTime,
      createdByUserId: snapshot.createdByUserId,
      updatedByUserId: snapshot.updatedByUserId,
      references: references.map((ref) => ({ id: ref.targetId, alias: ref.alias ?? '' })),
    }
    if (snapshot.parentId !== null) {
      block.parentId = snapshot.parentId
    }
    return block
  }

  async applyChange(id: string, change: (doc: BlockData) => void): Promise<BlockData> {
    return await this.storage.transaction(this.workspaceId, async () => {
      const before = await this.loadBlockData(id)
      if (!before) {
        throw new Error(`Block not found: ${id}`)
      }
      const draft = structuredCloneOrJson(before)
      change(draft)
      draft.updateTime = Date.now()
      draft.updatedByUserId = this.currentUser.id

      await this.persistBlockDiff(before, draft)
      return draft
    })
  }

  async deleteBlock(id: string): Promise<void> {
    await this.storage.transaction(this.workspaceId, async () => {
      await this.storage.blocks.markDeleted({ workspaceId: this.workspaceId, blockId: id })
    })
  }

  private async persistBlockDiff(before: BlockData, after: BlockData): Promise<void> {
    await this.storage.blocks.updateBlock(
      { workspaceId: this.workspaceId, blockId: after.id },
      {
        content: after.content,
        parentId: after.parentId ?? null,
        updateTime: after.updateTime,
        updatedByUserId: after.updatedByUserId,
      }
    )

    await this.persistPropertiesDiff(after.id, before.properties, after.properties)
    await this.persistReferencesDiff(after.id, before.references, after.references)
    await this.persistChildrenDiff(after.id, before.childIds, after.childIds)
  }

  private async persistPropertiesDiff(
    blockId: string,
    before: BlockProperties,
    after: BlockProperties
  ): Promise<void> {
    const beforeKeys = new Set(Object.keys(before ?? {}))
    const afterEntries = Object.entries(after ?? {})

    for (const [name, property] of afterEntries) {
      if (!property) continue
      await this.storage.properties.upsert(toPropertyRecord(this.workspaceId, blockId, property))
      beforeKeys.delete(name)
    }

    for (const removed of beforeKeys) {
      await this.storage.properties.remove({ workspaceId: this.workspaceId, blockId }, removed)
    }
  }

  private async persistReferencesDiff(
    blockId: string,
    before: BlockData['references'],
    after: BlockData['references']
  ): Promise<void> {
    const beforeKey = before.map((ref) => `${ref.id}:${ref.alias ?? ''}`).join('|')
    const afterKey = after.map((ref) => `${ref.id}:${ref.alias ?? ''}`).join('|')
    if (beforeKey === afterKey) return

    await this.storage.references.replaceAll(
      { workspaceId: this.workspaceId, blockId },
      toReferenceRecords(this.workspaceId, blockId, after)
    )
  }

  private async persistChildrenDiff(parentId: string, before: string[], after: string[]): Promise<void> {
    const afterSet = new Set(after)

    for (const removed of before) {
      if (!afterSet.has(removed)) {
        await this.storage.blocks.updateBlock(
          { workspaceId: this.workspaceId, blockId: removed },
          { parentId: null, orderKey: orderKeyForIndex(0) }
        )
      }
    }

    for (const [index, childId] of after.entries()) {
      await this.storage.blocks.updateBlock(
        { workspaceId: this.workspaceId, blockId: childId },
        { parentId, orderKey: orderKeyForIndex(index) }
      )
    }
  }
}
