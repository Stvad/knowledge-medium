/**
 * The fixture as a graph stores it, in a form that does not depend on the
 * workspace. One line per block the export defines, found by the id the
 * importer derives from its Roam uid; one per block those sit under or link
 * to that the import derives instead (a daily page, whose id comes from its
 * date; a page a link minted); and one per block under any of these that is
 * neither (a hand-written todo, a leftover). Block ids inside a line are named
 * by uid, by the derived block's content, or otherwise '?'. Position is a rank
 * among siblings, because a block the runner moved back keeps a new order
 * key; pages have none, as top-level order means nothing and differs per
 * import. Equal lines mean the same fixture state, whichever workspace holds
 * it. The rest of the workspace is not compared: the app's own pages
 * (onboarding, property definitions, import logs) differ per workspace.
 */
import { roamBlockId } from '@/plugins/roam-import/blockIds'
import type { RoamBlock, RoamPage } from '@/plugins/roam-import/types'
import { type GraphProbe, sqlAll } from './graphQueries'

const BLOCK_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

interface StoredRow {
  id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  deleted: number
}

const uidsOf = (blocks: ReadonlyArray<RoamBlock | RoamPage>): string[] =>
  blocks.flatMap(block => [block.uid, ...uidsOf(block.children ?? [])])

const STORED_COLUMNS = 'id, parent_id, order_key, content, properties_json, references_json, deleted'

const rowsWhere = async <T>(probe: GraphProbe, column: 'id' | 'parent_id', values: readonly string[], columns: string): Promise<T[]> => {
  const rows: T[] = []
  for (let start = 0; start < values.length; start += 500) {
    const chunk = values.slice(start, start + 500)
    rows.push(...await sqlAll<T>(probe, `SELECT ${columns} FROM blocks WHERE ${column} IN (${chunk.map(() => '?').join(', ')})`, chunk))
  }
  return rows
}

export const fixtureState = async (probe: GraphProbe, pages: readonly RoamPage[]): Promise<string[]> => {
  const uidById = new Map(uidsOf(pages).map(uid => [roamBlockId(probe.workspaceId, uid), uid]))
  const exported = await rowsWhere<StoredRow>(probe, 'id', [...uidById.keys()], STORED_COLUMNS)
  const pointedAt = new Set(exported.flatMap(row =>
    `${row.parent_id ?? ''} ${row.content} ${row.properties_json} ${row.references_json}`.match(BLOCK_ID) ?? []))
  const derived = await rowsWhere<StoredRow>(probe, 'id', [...pointedAt].filter(id => !uidById.has(id)), STORED_COLUMNS)
  const others = (await rowsWhere<StoredRow>(probe, 'parent_id', [...exported, ...derived].map(row => row.id), STORED_COLUMNS))
    .filter(row => !uidById.has(row.id))
  const rows = [...exported, ...derived, ...others]
  const names = new Map<string, string>([...uidById, ...derived.map(row => [row.id, `=${row.content}`] as const)])
  const named = (text: string) => text.replace(BLOCK_ID, id => names.get(id) ?? '?')

  const siblings = new Map<string, StoredRow[]>()
  for (const row of rows) {
    if (row.parent_id !== null) siblings.set(row.parent_id, [...(siblings.get(row.parent_id) ?? []), row])
  }
  const rank = new Map<string, number>()
  for (const group of siblings.values()) {
    group.sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0))
      .forEach((row, index) => rank.set(row.id, index))
  }
  return rows.map(row => JSON.stringify([
    names.get(row.id) ?? `+${named(row.content).slice(0, 60)}`,
    named(row.parent_id ?? ''),
    rank.get(row.id) ?? null,
    named(row.content),
    named(row.properties_json),
    named(row.references_json),
    row.deleted,
  ])).sort()
}

/** The blocks, by the names `fixtureState` gives them, on which two states differ. */
export const differingBlocks = (a: readonly string[], b: readonly string[]): string[] => {
  const inA = new Set(a)
  const inB = new Set(b)
  const name = (line: string) => (JSON.parse(line) as [string])[0]
  return [...new Set([...a.filter(line => !inB.has(line)), ...b.filter(line => !inA.has(line))].map(name))]
}
