/**
 * Fixture generators for the bench suite.
 *
 *   - `populateLinearChain` — A → B → C → … (depth N, each block has one
 *     child). Stresses path-INSTR in the recursion guard, ANCESTORS_SQL,
 *     IS_DESCENDANT_OF_SQL.
 *   - `populateBalanced` — k-ary balanced tree of depth D. Stresses
 *     SUBTREE_SQL worst case + handle dep-registration density.
 *   - `populateFanOut` — one parent with N siblings. Stresses CHILDREN_SQL
 *     ordering, BlockCache.childrenOf sort, orderKey insert at boundaries.
 *   - `populateFlat` — N roots in a workspace, no nesting. The cheapest
 *     way to fill the DB to a target size for big-DB baselines.
 *   - `populateRealistic` — mixed-shape outline (pages with sub-bullets),
 *     a closer proxy to user data than the pure shapes.
 *
 * All generators bypass `repo.tx`/`repo.mutate` and `INSERT` directly via
 * `db.execute` for raw speed — populating 100k rows through `repo.tx`
 * would take orders of magnitude longer (one writeTransaction per row,
 * triggers fire per row, command_events row written per row). For
 * benchmarks that measure the engine path, use the public mutators
 * directly. The fixture builders are for building "large preloaded DB"
 * states.
 */

import { v4 as uuidv4 } from 'uuid'
import type { PowerSyncDb } from '@/data/internals/commitPipeline'

export const DEFAULT_WORKSPACE = 'ws-bench'
export const DEFAULT_USER = 'bench-user'

const INSERT_BLOCK_SQL = `
  INSERT INTO blocks
    (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
     created_at, updated_at, created_by, updated_by, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
`

interface InsertParams {
  id: string
  workspaceId: string
  parentId: string | null
  orderKey: string
  content?: string
  propertiesJson?: string
  referencesJson?: string
  createdAt?: number
  updatedAt?: number
}

const insert = async (db: PowerSyncDb, p: InsertParams) =>
  db.execute(INSERT_BLOCK_SQL, [
    p.id,
    p.workspaceId,
    p.parentId,
    p.orderKey,
    p.content ?? '',
    p.propertiesJson ?? '{}',
    p.referencesJson ?? '[]',
    p.createdAt ?? Date.now(),
    p.updatedAt ?? Date.now(),
    DEFAULT_USER,
    DEFAULT_USER,
  ])

/** Generate an order_key sequence of length n. We use lexicographically
 *  monotonic strings ('a000', 'a001', …, 'a999', 'b000', …) — not the
 *  jittered fractional indexer, because we don't need correctness vs
 *  inserts here, just fast distinct keys. The tree CTEs sort by this
 *  string so the shape stays sensible. */
export const orderKeySeq = (n: number): string[] => {
  const out: string[] = []
  const alpha = 'abcdefghijklmnopqrstuvwxyz'
  // 4-char lexicographic sequence: alpha[i0]+digit[i1..i3]
  // Plenty of headroom for 1M+ keys.
  for (let i = 0; i < n; i++) {
    const a = alpha[Math.floor(i / 1_000_000) % 26]
    const b = alpha[Math.floor(i / 100_000) % 10]
    const c = alpha[Math.floor(i / 10_000) % 10]
    const d = String(i % 10000).padStart(4, '0')
    out.push(`${a}${b}${c}${d}`)
  }
  return out
}

export interface ChainResult {
  workspaceId: string
  rootId: string
  leafId: string
  ids: string[]
}

/** Linear chain: rootId → child1 → child2 → … → leafId.
 *  Wrapped in one writeTransaction so the entire population is a single
 *  SQL transaction (much faster than one per row). */
export const populateLinearChain = async (
  db: PowerSyncDb,
  depth: number,
  opts: {workspaceId?: string} = {},
): Promise<ChainResult> => {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE
  const ids = Array.from({length: depth}, () => uuidv4())
  await db.writeTransaction(async (tx) => {
    let parentId: string | null = null
    for (let i = 0; i < depth; i++) {
      await tx.execute(INSERT_BLOCK_SQL, [
        ids[i], workspaceId, parentId, 'a0001', `chain-${i}`, '{}', '[]',
        Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
      ])
      parentId = ids[i]
    }
  })
  return {workspaceId, rootId: ids[0], leafId: ids[ids.length - 1], ids}
}

export interface BalancedResult {
  workspaceId: string
  rootId: string
  /** All ids in the tree, root-first BFS order. */
  ids: string[]
  /** ids of leaves (at depth = `depth`). */
  leafIds: string[]
  totalNodes: number
}

/** Balanced k-ary tree of given depth (root counts as depth 0).
 *  totalNodes = (k^(depth+1) - 1) / (k - 1) for k > 1, depth+1 for k=1. */
export const populateBalanced = async (
  db: PowerSyncDb,
  branching: number,
  depth: number,
  opts: {workspaceId?: string; contentPrefix?: string} = {},
): Promise<BalancedResult> => {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE
  const contentPrefix = opts.contentPrefix ?? 'b'
  const ids: string[] = []
  const leafIds: string[] = []
  // BFS construction: a queue of (id, depth-from-root).
  const rootId = uuidv4()
  const queue: Array<{id: string; d: number}> = [{id: rootId, d: 0}]
  ids.push(rootId)
  if (depth === 0) leafIds.push(rootId)

  await db.writeTransaction(async (tx) => {
    await tx.execute(INSERT_BLOCK_SQL, [
      rootId, workspaceId, null, 'a0001', `${contentPrefix}-root`, '{}', '[]',
      Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
    ])
    while (queue.length > 0) {
      const node = queue.shift()!
      if (node.d === depth) continue
      const childKeys = orderKeySeq(branching)
      for (let k = 0; k < branching; k++) {
        const cid = uuidv4()
        ids.push(cid)
        await tx.execute(INSERT_BLOCK_SQL, [
          cid, workspaceId, node.id, childKeys[k], `${contentPrefix}-${node.d + 1}-${k}`, '{}', '[]',
          Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
        ])
        if (node.d + 1 === depth) leafIds.push(cid)
        else queue.push({id: cid, d: node.d + 1})
      }
    }
  })

  return {workspaceId, rootId, ids, leafIds, totalNodes: ids.length}
}

export interface FanOutResult {
  workspaceId: string
  parentId: string
  childIds: string[]
}

/** One parent + N siblings, all under workspace root. */
export const populateFanOut = async (
  db: PowerSyncDb,
  childCount: number,
  opts: {workspaceId?: string} = {},
): Promise<FanOutResult> => {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE
  const parentId = uuidv4()
  const childIds: string[] = []
  const keys = orderKeySeq(childCount)
  await db.writeTransaction(async (tx) => {
    await tx.execute(INSERT_BLOCK_SQL, [
      parentId, workspaceId, null, 'a0001', 'fanout-parent', '{}', '[]',
      Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
    ])
    for (let i = 0; i < childCount; i++) {
      const id = uuidv4()
      childIds.push(id)
      await tx.execute(INSERT_BLOCK_SQL, [
        id, workspaceId, parentId, keys[i], `child-${i}`, '{}', '[]',
        Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
      ])
    }
  })
  return {workspaceId, parentId, childIds}
}

export interface FlatResult {
  workspaceId: string
  ids: string[]
}

/** N flat root rows in a workspace. Cheapest fill for big-DB baselines. */
export const populateFlat = async (
  db: PowerSyncDb,
  count: number,
  opts: {workspaceId?: string; batchSize?: number} = {},
): Promise<FlatResult> => {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE
  const batchSize = opts.batchSize ?? 5000
  const ids: string[] = []
  for (let off = 0; off < count; off += batchSize) {
    const upper = Math.min(off + batchSize, count)
    const keys = orderKeySeq(upper - off)
    await db.writeTransaction(async (tx) => {
      for (let i = off; i < upper; i++) {
        const id = uuidv4()
        ids.push(id)
        await tx.execute(INSERT_BLOCK_SQL, [
          id, workspaceId, null, keys[i - off], `flat-${i}`, '{}', '[]',
          Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
        ])
      }
    })
  }
  return {workspaceId, ids}
}

export interface RealisticResult {
  workspaceId: string
  pageIds: string[]
  /** All ids, BFS order. */
  ids: string[]
}

/** A coarse "outline-shaped" workspace: `pages` root pages, each with
 *  `bulletsPerPage` direct children, each of those with `subBulletsPerBullet`
 *  leaves. Useful as a stand-in for a typical Workflowy/Roam corpus. */
export const populateRealistic = async (
  db: PowerSyncDb,
  args: {pages: number; bulletsPerPage: number; subBulletsPerBullet: number; workspaceId?: string},
): Promise<RealisticResult> => {
  const workspaceId = args.workspaceId ?? DEFAULT_WORKSPACE
  const ids: string[] = []
  const pageIds: string[] = []
  const pageKeys = orderKeySeq(args.pages)
  await db.writeTransaction(async (tx) => {
    for (let p = 0; p < args.pages; p++) {
      const pid = uuidv4()
      ids.push(pid); pageIds.push(pid)
      await tx.execute(INSERT_BLOCK_SQL, [
        pid, workspaceId, null, pageKeys[p], `Page ${p}`, '{}', '[]',
        Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
      ])
      const bulletKeys = orderKeySeq(args.bulletsPerPage)
      for (let b = 0; b < args.bulletsPerPage; b++) {
        const bid = uuidv4()
        ids.push(bid)
        await tx.execute(INSERT_BLOCK_SQL, [
          bid, workspaceId, pid, bulletKeys[b], `Bullet ${p}-${b}`, '{}', '[]',
          Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
        ])
        const subKeys = orderKeySeq(args.subBulletsPerBullet)
        for (let s = 0; s < args.subBulletsPerBullet; s++) {
          const sid = uuidv4()
          ids.push(sid)
          await tx.execute(INSERT_BLOCK_SQL, [
            sid, workspaceId, bid, subKeys[s], `Sub ${p}-${b}-${s}`, '{}', '[]',
            Date.now(), Date.now(), DEFAULT_USER, DEFAULT_USER,
          ])
        }
      }
    }
  })
  return {workspaceId, pageIds, ids}
}

/** Build a `references_json` value with N references to randomly chosen
 *  ids from the candidate pool. Used when populating a workspace with
 *  link density. */
export const buildReferencesJson = (refs: string[]): string =>
  JSON.stringify(refs.map(id => ({id, alias: id})))

/** Update N rows to carry K references each, picked from the candidate
 *  pool. Used by the search/backlinks bench to make the JSON1 scan
 *  meaningful. Does direct SQL UPDATE — bypasses repo.tx because we're
 *  pre-populating, not measuring writes. */
export const seedReferences = async (
  db: PowerSyncDb,
  args: {sourceIds: string[]; targetIds: string[]; refsPerSource: number},
): Promise<void> => {
  await db.writeTransaction(async (tx) => {
    for (const sid of args.sourceIds) {
      const refs: string[] = []
      for (let i = 0; i < args.refsPerSource; i++) {
        refs.push(args.targetIds[(refs.length * 7919 + i * 1117) % args.targetIds.length])
      }
      await tx.execute(
        'UPDATE blocks SET references_json = ?, updated_at = ? WHERE id = ?',
        [buildReferencesJson(refs), Date.now(), sid],
      )
    }
  })
}

/** Set a property on N rows — used to seed `aliasesInWorkspace` /
 *  `findBlocksByType` benchmarks. */
export const seedProperty = async (
  db: PowerSyncDb,
  args: {ids: string[]; key: string; valueFor: (id: string, ix: number) => unknown},
): Promise<void> => {
  await db.writeTransaction(async (tx) => {
    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]
      const props: Record<string, unknown> = {[args.key]: args.valueFor(id, i)}
      await tx.execute(
        'UPDATE blocks SET properties_json = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(props), Date.now(), id],
      )
    }
  })
}

/** Re-export the insert helper for ad-hoc fixture extensions inside a
 *  bench file. Keeps the SQL constant in one place. */
export const insertRow = insert
