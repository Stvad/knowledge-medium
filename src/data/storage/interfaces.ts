import { BlockData } from '@/types'

export interface BlockIdentifier {
  workspaceId: string
  blockId: string
}

export interface PropertyRecord extends BlockIdentifier {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  valueJson: string | null
  changeScope: string | null
}

export interface ReferenceRecord extends BlockIdentifier {
  targetWorkspaceId: string
  targetId: string
  refType: string
  origin: 'text' | 'property'
  alias?: string | null
  spanStart?: number | null
  spanEnd?: number | null
  sourcePropertyName?: string | null
  sourcePropertyPath: string
  ordinal?: number | null
  metaJson?: string | null
  createdAt?: number | null
  updatedAt?: number | null
}

export interface BlockSnapshot extends BlockIdentifier {
  parentId: string | null
  orderKey: string
  content: string
  createTime: number
  updateTime: number
  createdByUserId: string
  updatedByUserId: string
  isDeleted: boolean
}

export type QueryResult<T> = {
  rows: T[]
  updatedAt?: number
}

export interface LiveQueryHandle<T> {
  current(): QueryResult<T>
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface ChangeSession {
  readonly workspaceId: string
  run<T>(fn: () => Promise<T> | T): Promise<T>
  enqueueUndo?(inverse: () => Promise<void> | void): void
}

export interface BlockStore {
  getBlock(id: BlockIdentifier): Promise<BlockSnapshot | null>
  listChildren(parent: BlockIdentifier | { workspaceId: string; parentId: string | null }): Promise<BlockSnapshot[]>
  createBlock(data: Partial<BlockData> & { workspaceId: string; parentId?: string | null }): Promise<BlockSnapshot>
  updateBlock(sn: BlockIdentifier, patch: Partial<Omit<BlockSnapshot, keyof BlockIdentifier>>): Promise<void>
  markDeleted(sn: BlockIdentifier): Promise<void>
}

export interface PropertyStore {
  list(block: BlockIdentifier): Promise<PropertyRecord[]>
  upsert(record: PropertyRecord): Promise<void>
  remove(block: BlockIdentifier, name: string): Promise<void>
}

export interface ReferenceStore {
  listBySource(block: BlockIdentifier): Promise<ReferenceRecord[]>
  replaceAll(block: BlockIdentifier, records: ReferenceRecord[]): Promise<void>
}

export interface StorageEngine {
  open(): Promise<void>
  close(): Promise<void>
  withSession(workspaceId: string, fn: (session: ChangeSession) => Promise<void>): Promise<void>
  liveQuery<T>(sql: string, params: unknown[], mapper: (row: any) => T): Promise<LiveQueryHandle<T>>
  readonly blocks: BlockStore
  readonly properties: PropertyStore
  readonly references: ReferenceStore
}

export interface StorageMapping {
  automergeModule: string
  entryPoints: string[]
  replacement: keyof StorageEngine | 'hooks'
}

export const AUTOMERGE_TO_STORAGE_MAPPINGS: StorageMapping[] = [
  {
    automergeModule: '@/data/repo',
    entryPoints: ['Repo.find', 'Repo.create'],
    replacement: 'blocks',
  },
  {
    automergeModule: '@/data/block',
    entryPoints: [
      'Block.change',
      'Block.children',
      'Block.parent',
      'Block.hasChildren',
      'Block.indent',
      'Block.outdent',
      'Block.delete',
    ],
    replacement: 'blocks',
  },
  {
    automergeModule: '@/data/automerge',
    entryPoints: ['useDocumentWithSelector'],
    replacement: 'hooks',
  },
]
