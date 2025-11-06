import { BlockData, BlockProperty } from '@/types'
import { SqliteRepo } from '@/data/sqliteRepo'

export type SqliteChangeFn<T> = (doc: T) => void

function ensureDocShape(doc: BlockData): void {
  if (!doc.childIds) doc.childIds = []
  if (!doc.properties) doc.properties = {}
  if (!doc.references) doc.references = []
}

export class SqliteBlock {
  constructor(
    readonly repo: SqliteRepo,
    readonly id: string
  ) {}

  get currentUser() {
    return this.repo.currentUser
  }

  async data(): Promise<BlockData | undefined> {
    return this.repo.loadBlockData(this.id)
  }

  async change(change: SqliteChangeFn<BlockData>): Promise<void> {
    await this.repo.applyChange(this.id, (doc) => {
      ensureDocShape(doc)
      change(doc)
    })
  }

  async parent(): Promise<SqliteBlock | null> {
    const doc = await this.data()
    if (!doc?.parentId) return null
    return this.repo.find(doc.parentId)
  }

  async children(): Promise<SqliteBlock[]> {
    const doc = await this.data()
    if (!doc?.childIds?.length) return []
    return doc.childIds.map((childId) => this.repo.find(childId))
  }

  async hasChildren(): Promise<boolean> {
    const doc = await this.data()
    return (doc?.childIds.length ?? 0) > 0
  }

  async createChild({
    data = {},
    position = 'last',
  }: {
    data?: Partial<BlockData>
    position?: 'first' | 'last' | number
  } = {}): Promise<SqliteBlock> {
    const newBlock = await this.repo.create({
      ...data,
      parentId: this.id,
    })

    await this.change((doc) => {
      if (position === 'first') {
        doc.childIds.unshift(newBlock.id)
      } else if (typeof position === 'number') {
        doc.childIds.splice(position, 0, newBlock.id)
      } else {
        doc.childIds.push(newBlock.id)
      }
    })

    return newBlock
  }

  async setProperty<T extends BlockProperty>(property: T): Promise<void> {
    await this.change((doc) => {
      doc.properties[property.name] = property
    })
  }

  async delete(): Promise<void> {
    const parent = await this.parent()
    if (parent) {
      await parent.change((doc) => {
        const index = doc.childIds.indexOf(this.id)
        if (index >= 0) doc.childIds.splice(index, 1)
      })
    }
    await this.repo.deleteBlock(this.id)
  }
}
