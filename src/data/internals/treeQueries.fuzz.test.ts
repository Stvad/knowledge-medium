// @vitest-environment node
/**
 * Differential fuzz suite for the recursive tree CTEs (`treeQueries.ts`) and
 * the coalesced ancestor walk over them (`ancestorBatch.ts`) — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics and `docs/fuzzing.md`
 * for suite conventions.
 *
 * Random parent-pointer graphs are written RAW into a real test DB and every
 * statement is diffed against `TreeModel`, a pure-JS walk over the generated
 * rows written from each statement's docblock, never from its SQL: it follows
 * parent pointers with a visited set instead of a path string, so a path
 * encoding slip (separator ordering, an INSTR false hit, a hex prefix) shows
 * as a divergence.
 *
 * ──── Semantics the model encodes ────
 *
 * - `SUBTREE_SQL`: nothing for a missing or soft-deleted root; else the root
 *   at depth 0, then depth-first, siblings by `(order_key, id)` under SQLite's
 *   BINARY collation (UTF-8 bytes — not JS's UTF-16 `<`). Soft-deleted rows
 *   and everything below them are absent; a child already on the current
 *   branch (a cycle closing) is skipped.
 * - `manyAncestorsSql`: per live seed, the seed at depth 0 then each parent
 *   up to the first missing, soft-deleted or already-visited one; rows by
 *   `(chain_start_id, depth)`. A duplicated seed is one chain.
 * - `ancestorWalk`: that chain minus the seed, and `stoppedAtParentId` = the
 *   topmost row's `parent_id` (null at a root, the cut parent otherwise);
 *   an id with no live row gets the empty walk. Every id is requested in one
 *   microtask, duplicates included, so the batcher's coalescing is on the
 *   path.
 * - `IS_DESCENDANT_OF_SQL(id, anc)`: `anc` is `id` itself or reachable up
 *   `id`'s parent chain THROUGH soft-deleted rows (issue #183); a missing `id`
 *   is never a descendant.
 * - `cycleScanSql(ids)`: every member of each cycle that some scanned id
 *   lies ON (deleted rows included); an id on a tail leading into a cycle
 *   reports nothing.
 * - `CHILDREN_SQL`: live rows naming the parent, by `(order_key, id)`.
 *
 * ──── Generator emphasis ────
 *
 * Ids mix `/`, `!`, accented, CJK, astral and high-BMP characters and
 * prefix-related spellings (`a` / `ab`), so the hex segments collide on
 * prefixes and BINARY order differs from UTF-16 order. Parents are mostly an
 * earlier node (a forest), sometimes any node (cycles, self-loops), sometimes
 * a dangling id; a fifth of the rows are soft-deleted; order keys draw from
 * a tiny alphanumeric alphabet so ties and prefix keys (`a` vs `a0`) are
 * common. The canary test asserts the generators actually reach each of
 * these shapes.
 *
 * ──── Deliberately NOT covered ────
 *
 * - The `depth < 100` cap: generated graphs are small, and the example tests
 *   in `treeQueries.test.ts` pin it.
 * - Order keys outside the alphanumeric alphabet (a `!` or a byte below it
 *   would break the path encoding's separator ordering): every key the app
 *   mints is alphanumeric.
 * - The VISIBLE_* field-row pruning (`visibleChildren.fuzz.test.ts` owns it)
 *   and workspace scoping (these statements do not filter by workspace).
 * - Lone UTF-16 surrogates in ids: the driver folds them at the bind
 *   boundary, which would fail the property for an unrelated reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { ancestorWalk } from './ancestorBatch'
import {
  CHILDREN_SQL,
  IS_DESCENDANT_OF_SQL,
  SUBTREE_SQL,
  cycleScanSql,
  manyAncestorsSql,
} from './treeQueries'

const GHOST = 'ghost-never-inserted'

interface Node {
  readonly id: string
  readonly parentId: string | null
  readonly orderKey: string
  readonly deleted: boolean
}

/** SQLite's BINARY collation: memcmp over UTF-8. */
const binary = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

// ──── The model ────

type CoverageKey =
  | 'self-loop'
  | 'cycle of two or more'
  | 'tail into a cycle'
  | 'dangling parent'
  | 'walk cut at a deleted parent'
  | 'walk cut at a missing parent'
  | 'walk cut at a visited parent'
  | 'subtree three levels deep'
  | 'subtree skipped a cycle-closing child'
  | 'order_key tie between live siblings'
  | 'order_key prefix between live siblings'
  | 'descendant only through a deleted row'

const COVERAGE_KEYS: readonly CoverageKey[] = [
  'self-loop', 'cycle of two or more', 'tail into a cycle', 'dangling parent',
  'walk cut at a deleted parent', 'walk cut at a missing parent', 'walk cut at a visited parent',
  'subtree three levels deep', 'subtree skipped a cycle-closing child',
  'order_key tie between live siblings', 'order_key prefix between live siblings',
  'descendant only through a deleted row',
]

interface ChainRow {
  readonly start: string
  readonly id: string
  readonly depth: number
  readonly parentId: string | null
}

class TreeModel {
  private readonly byId: ReadonlyMap<string, Node>

  constructor(readonly nodes: readonly Node[], private readonly coverage?: Map<CoverageKey, number>) {
    this.byId = new Map(nodes.map(n => [n.id, n]))
  }

  private hit(key: CoverageKey): void {
    if (this.coverage) this.coverage.set(key, (this.coverage.get(key) ?? 0) + 1)
  }

  children(parentId: string): Node[] {
    const out = this.nodes
      .filter(n => n.parentId === parentId && !n.deleted)
      .sort((a, b) => binary(a.orderKey, b.orderKey) || binary(a.id, b.id))
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]!.orderKey === out[i]!.orderKey) this.hit('order_key tie between live siblings')
      else if (out[i]!.orderKey.startsWith(out[i - 1]!.orderKey)) {
        this.hit('order_key prefix between live siblings')
      }
    }
    return out
  }

  subtree(rootId: string): {id: string; depth: number}[] {
    const root = this.byId.get(rootId)
    if (root === undefined || root.deleted) return []
    const out: {id: string; depth: number}[] = []
    const visit = (node: Node, depth: number, branch: ReadonlySet<string>) => {
      out.push({id: node.id, depth})
      if (depth >= 3) this.hit('subtree three levels deep')
      for (const child of this.children(node.id)) {
        if (branch.has(child.id)) {
          this.hit('subtree skipped a cycle-closing child')
          continue
        }
        visit(child, depth + 1, new Set([...branch, child.id]))
      }
    }
    visit(root, 0, new Set([root.id]))
    return out
  }

  ancestors(seedId: string): ChainRow[] {
    const seed = this.byId.get(seedId)
    if (seed === undefined || seed.deleted) return []
    const rows: ChainRow[] = []
    const visited = new Set<string>()
    let current: Node = seed
    for (;;) {
      rows.push({start: seedId, id: current.id, depth: rows.length, parentId: current.parentId})
      visited.add(current.id)
      if (current.parentId === null) break
      const parent = this.byId.get(current.parentId)
      if (parent === undefined) { this.hit('walk cut at a missing parent'); break }
      if (parent.deleted) { this.hit('walk cut at a deleted parent'); break }
      if (visited.has(parent.id)) { this.hit('walk cut at a visited parent'); break }
      current = parent
    }
    return rows
  }

  manyAncestors(seedIds: readonly string[]): ChainRow[] {
    return [...new Set(seedIds)]
      .sort(binary)
      .flatMap(id => this.ancestors(id))
  }

  walk(seedId: string): {stoppedAtParentId: string | null; chain: string[]} {
    const rows = this.ancestors(seedId)
    if (rows.length === 0) return {stoppedAtParentId: null, chain: []}
    return {stoppedAtParentId: rows[rows.length - 1]!.parentId, chain: rows.slice(1).map(r => r.id)}
  }

  /** Every row up `id`'s parent chain, soft-deleted ones included, `id` first. */
  private structuralChain(id: string): Node[] {
    const start = this.byId.get(id)
    if (start === undefined) return []
    const chain = [start]
    const seen = new Set([id])
    let current = start
    while (current.parentId !== null) {
      const parent = this.byId.get(current.parentId)
      if (parent === undefined || seen.has(parent.id)) break
      chain.push(parent)
      seen.add(parent.id)
      current = parent
    }
    return chain
  }

  isDescendantOf(id: string, potentialAncestor: string): boolean {
    const chain = this.structuralChain(id)
    const at = chain.findIndex(n => n.id === potentialAncestor)
    if (at > 0 && chain.slice(1, at).some(n => n.deleted)) this.hit('descendant only through a deleted row')
    return at >= 0
  }

  cycleMembers(ids: readonly string[]): string[] {
    const members = new Set<string>()
    for (const id of new Set(ids)) {
      const chain = this.structuralChain(id)
      const top = chain[chain.length - 1]
      // The chain stopped at a visited row: a cycle closes there. `id` lies
      // on it only when the closing edge points back at `id` itself.
      if (top === undefined || top.parentId === null || !this.byId.has(top.parentId)) continue
      if (top.parentId === id) {
        this.hit(chain.length === 1 ? 'self-loop' : 'cycle of two or more')
        for (const n of chain) members.add(n.id)
      } else {
        this.hit('tail into a cycle')
      }
    }
    return [...members].sort(binary)
  }

  noteShape(): void {
    if (this.nodes.some(n => n.parentId !== null && !this.byId.has(n.parentId))) this.hit('dangling parent')
  }
}

// ──── Generators ────

const ID_POOL = [
  'a', 'ab', 'abc', 'b', 'B', 'a/b', 'a!b', 'a/', '!', 'daily/ws/2026-01-01',
  'é', 'é', '中文', '\u{1F600}', '', '�', 'A0', '0',
]

const idArb = fc.oneof(
  fc.constantFrom(...ID_POOL),
  fc.string({unit: fc.constantFrom('a', 'b', '/', '!', 'é', '\u{1F600}', ''), minLength: 1, maxLength: 4}),
)

const parentArb = fc.oneof(
  {weight: 2, arbitrary: fc.constant({kind: 'root' as const})},
  {weight: 6, arbitrary: fc.nat().map(pick => ({kind: 'earlier' as const, pick}))},
  {weight: 2, arbitrary: fc.nat().map(pick => ({kind: 'any' as const, pick}))},
  {weight: 1, arbitrary: fc.constant({kind: 'dangling' as const})},
)

const rawNodeArb = fc.record({
  parent: parentArb,
  orderKey: fc.string({unit: fc.constantFrom('0', '1', 'a', 'A', 'z', 'Z'), minLength: 1, maxLength: 3}),
  deleted: fc.nat({max: 4}).map(n => n === 0),
})

const worldArb = fc.record({
  ids: fc.uniqueArray(idArb, {minLength: 2, maxLength: 14}),
  nodes: fc.array(rawNodeArb, {minLength: 14, maxLength: 14}),
  /** Index picks for the multi-seed and pairwise statements; resolved
   *  modulo the id count, with one slot past the end standing for GHOST. */
  ancestorSeeds: fc.array(fc.nat(), {minLength: 1, maxLength: 8}),
  descendantPairs: fc.array(fc.tuple(fc.nat(), fc.nat()), {minLength: 1, maxLength: 12}),
  cycleScanSets: fc.array(fc.array(fc.nat(), {minLength: 1, maxLength: 6}), {minLength: 1, maxLength: 3}),
})

type World = typeof worldArb extends fc.Arbitrary<infer W> ? W : never

const resolveNodes = ({ids, nodes}: World): Node[] => ids.map((id, i) => {
  const raw = nodes[i]!
  const parentId =
    raw.parent.kind === 'root' ? null
      : raw.parent.kind === 'dangling' ? GHOST
        : raw.parent.kind === 'earlier' ? (i === 0 ? null : ids[raw.parent.pick % i]!)
          : ids[raw.parent.pick % ids.length]!
  return {id, parentId, orderKey: raw.orderKey, deleted: raw.deleted}
})

const pickId = (ids: readonly string[], n: number): string => ids[n % (ids.length + 1)] ?? GHOST

// ──── DB plumbing ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

/** Rows are written raw with explicit order keys, so there is no
 *  `Math.random` to pin: barrier only. */
const guard = statefulFuzzGuard()

/** Raw, with `tx_context.source` left NULL by the reset: the shape a
 *  sync-applied row has, so no parent validation refuses a cycle or a
 *  dangling parent. */
const insertNodes = async (nodes: readonly Node[]) => {
  await sharedDb.db.writeTransaction(async tx => {
    for (const n of nodes) {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
           references_json, created_at, updated_at, created_by, updated_by, deleted)
         VALUES (?, 'ws', ?, ?, '', '{}', '[]', 0, 0, 'u', 'u', ?)`,
        [n.id, n.parentId, n.orderKey, n.deleted ? 1 : 0],
      )
    }
  })
}

interface SqlChainRow {
  chain_start_id: string
  id: string
  depth: number
  parent_id: string | null
}

const runWorld = async (world: World, model: TreeModel) => {
  const db = sharedDb.db
  const ids = world.ids
  const probes = [...ids, GHOST]

  for (const root of probes) {
    const rows = await db.getAll<{id: string; depth: number}>(SUBTREE_SQL, [root])
    expect({root, subtree: rows.map(r => ({id: r.id, depth: r.depth}))})
      .toEqual({root, subtree: model.subtree(root)})

    const children = await db.getAll<{id: string}>(CHILDREN_SQL, [root])
    expect({root, children: children.map(r => r.id)})
      .toEqual({root, children: model.children(root).map(n => n.id)})
  }

  const seeds = world.ancestorSeeds.map(n => pickId(ids, n))
  const chainRows = await db.getAll<SqlChainRow>(manyAncestorsSql(seeds.length), seeds)
  expect({seeds, rows: chainRows.map(r => ({start: r.chain_start_id, id: r.id, depth: r.depth, parentId: r.parent_id}))})
    .toEqual({seeds, rows: model.manyAncestors(seeds)})

  // One microtask, duplicates included: the batcher answers them together.
  const requested = [...probes, ...seeds]
  const walks = await Promise.all(requested.map(id => ancestorWalk(db, id)))
  expect(requested.map((id, i) => ({
    id,
    stoppedAtParentId: walks[i]!.stoppedAtParentId,
    chain: walks[i]!.chain.map(r => r.id),
  }))).toEqual(requested.map(id => ({id, ...model.walk(id)})))

  for (const [a, b] of world.descendantPairs) {
    const id = pickId(ids, a)
    const potentialAncestor = pickId(ids, b)
    const hit = await db.getOptional<{hit: number}>(IS_DESCENDANT_OF_SQL, [id, potentialAncestor])
    expect({id, potentialAncestor, hit: hit !== null})
      .toEqual({id, potentialAncestor, hit: model.isDescendantOf(id, potentialAncestor)})
  }

  for (const set of [...world.cycleScanSets.map(s => s.map(n => pickId(ids, n))), probes]) {
    const hits = await db.getAll<{start_id: string}>(cycleScanSql(set.length), set)
    expect({set, members: hits.map(h => h.start_id).sort(binary)})
      .toEqual({set, members: model.cycleMembers(set)})
  }
}

describe('tree CTEs — differential vs a JS parent-pointer walk', () => {
  it('subtree, ancestors, ancestorWalk, isDescendantOf, cycleScan and children agree with the model', async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async world => {
        await guard.run(null, async () => {
          await resetTestDb(sharedDb.db)
          const nodes = resolveNodes(world)
          await insertNodes(nodes)
          // Precondition: the table holds exactly the generated rows.
          const {n} = await sharedDb.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks')
          expect(n).toBe(nodes.length)
          await runWorld(world, new TreeModel(nodes))
        })
      }),
      fuzzParams(40),
    )
  }, fuzzTestTimeout())

  it('the generators reach every shape the property is meant to cover (non-vacuity canary)', () => {
    const coverage = new Map<CoverageKey, number>()
    for (const world of fc.sample(worldArb, {seed: 20261105, numRuns: 300})) {
      const model = new TreeModel(resolveNodes(world), coverage)
      const ids = world.ids
      const probes = [...ids, GHOST]
      model.noteShape()
      for (const root of probes) model.subtree(root)
      for (const id of probes) model.walk(id)
      for (const a of probes) for (const b of probes) model.isDescendantOf(a, b)
      model.cycleMembers(probes)
    }
    expect(COVERAGE_KEYS.filter(key => !coverage.has(key))).toEqual([])
  })
})
