import { BlockData } from '@/types.ts'

export interface UndoRedoOptions<T = unknown> {
  scope?: string
  description?: string
  dependencies?: string[]
  skipMetadataUpdate?: boolean
  skipUndo?: boolean
  _marker?: T
}

type Snapshot = BlockData | null

interface ChangeRecord {
  id: string
  before: Snapshot
  after: Snapshot
}

interface HistoryEntry {
  scope: string
  description?: string
  changes: ChangeRecord[]
}

interface ActiveTransaction {
  scope: string
  description?: string
  depth: number
  changes: Map<string, ChangeRecord>
}

const cloneSnapshot = (snapshot: Snapshot): Snapshot =>
  snapshot ? structuredClone(snapshot) : null

const snapshotsEqual = (left: Snapshot, right: Snapshot) =>
  JSON.stringify(left) === JSON.stringify(right)

export class UndoRedoManager {
  private applier?: (changes: Array<{id: string, snapshot: Snapshot}>) => void
  private readonly history = new Map<string, HistoryEntry[]>()
  private readonly redoHistory = new Map<string, HistoryEntry[]>()
  private activeTransaction: ActiveTransaction | null = null

  setApplier(applier: (changes: Array<{id: string, snapshot: Snapshot}>) => void) {
    this.applier = applier
  }

  transaction(callback: () => void, options: UndoRedoOptions = {}) {
    const scope = options.scope ?? 'default'

    if (this.activeTransaction) {
      this.activeTransaction.depth += 1
      try {
        callback()
      } finally {
        this.finishTransaction()
      }
      return
    }

    this.activeTransaction = {
      scope,
      description: options.description,
      depth: 1,
      changes: new Map(),
    }

    try {
      callback()
    } finally {
      this.finishTransaction()
    }
  }

  recordChange(
    id: string,
    before: Snapshot,
    after: Snapshot,
    options: UndoRedoOptions = {},
  ) {
    if (options.skipUndo || snapshotsEqual(before, after)) {
      return
    }

    const scope = options.scope ?? 'default'

    if (this.activeTransaction) {
      this.captureChange(this.activeTransaction, id, before, after)
      return
    }

    const transaction: ActiveTransaction = {
      scope,
      description: options.description,
      depth: 0,
      changes: new Map(),
    }
    this.captureChange(transaction, id, before, after)
    this.commit(transaction)
  }

  undo(scope: string) {
    const history = this.history.get(scope)
    const entry = history?.pop()
    if (!entry) return false

    this.apply(entry.changes
      .slice()
      .reverse()
      .map(change => ({id: change.id, snapshot: cloneSnapshot(change.before)})))
    this.redoStack(scope).push(entry)
    return true
  }

  redo(scope: string) {
    const redoHistory = this.redoHistory.get(scope)
    const entry = redoHistory?.pop()
    if (!entry) return false

    this.apply(entry.changes
      .map(change => ({id: change.id, snapshot: cloneSnapshot(change.after)})))
    this.stack(scope).push(entry)
    return true
  }

  private finishTransaction() {
    if (!this.activeTransaction) return

    this.activeTransaction.depth -= 1
    if (this.activeTransaction.depth > 0) return

    const transaction = this.activeTransaction
    this.activeTransaction = null
    this.commit(transaction)
  }

  private captureChange(
    transaction: ActiveTransaction,
    id: string,
    before: Snapshot,
    after: Snapshot,
  ) {
    const existing = transaction.changes.get(id)
    if (existing) {
      existing.after = cloneSnapshot(after)
      return
    }

    transaction.changes.set(id, {
      id,
      before: cloneSnapshot(before),
      after: cloneSnapshot(after),
    })
  }

  private commit(transaction: ActiveTransaction) {
    if (transaction.changes.size === 0) return

    const entry: HistoryEntry = {
      scope: transaction.scope,
      description: transaction.description,
      changes: Array.from(transaction.changes.values()),
    }

    this.stack(transaction.scope).push(entry)
    this.redoHistory.set(transaction.scope, [])
  }

  private apply(changes: Array<{id: string, snapshot: Snapshot}>) {
    if (!this.applier) {
      throw new Error('UndoRedoManager applier has not been configured')
    }
    this.applier(changes)
  }

  private stack(scope: string) {
    let stack = this.history.get(scope)
    if (!stack) {
      stack = []
      this.history.set(scope, stack)
    }
    return stack
  }

  private redoStack(scope: string) {
    let stack = this.redoHistory.get(scope)
    if (!stack) {
      stack = []
      this.redoHistory.set(scope, stack)
    }
    return stack
  }
}
