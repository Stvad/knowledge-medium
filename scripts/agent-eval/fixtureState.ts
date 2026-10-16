/**
 * The fixture as a graph stores it, in a form that does not depend on the
 * workspace: one line per block the export defines, found by the id the
 * importer derives from its Roam uid. Block ids inside a line are named by
 * uid, or, for a row the import derives some other way (a daily page, a
 * page a link minted), by its content. Position is a rank among siblings,
 * because a block the runner moved back keeps a new order key; pages have
 * none, as top-level order means nothing and differs per import. Equal lines
 * mean the same fixture state, whichever workspace holds it.
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

const rowsWithIds = async <T>(probe: GraphProbe, ids: readonly string[], columns: string): Promise<T[]> => {
  const rows: T[] = []
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500)
    rows.push(...await sqlAll<T>(probe, `SELECT ${columns} FROM blocks WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk))
  }
  return rows
}

export const fixtureState = async (probe: GraphProbe, pages: readonly RoamPage[]): Promise<string[]> => {
  const uidById = new Map(uidsOf(pages).map(uid => [roamBlockId(probe.workspaceId, uid), uid]))
  const rows = await rowsWithIds<StoredRow>(probe, [...uidById.keys()],
    'id, parent_id, order_key, content, properties_json, references_json, deleted')
  const referenced = new Set(rows.flatMap(row =>
    `${row.parent_id ?? ''} ${row.content} ${row.properties_json} ${row.references_json}`.match(BLOCK_ID) ?? []))
  const derived = await rowsWithIds<{id: string, content: string}>(probe, [...referenced].filter(id => !uidById.has(id)), 'id, content')
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
    uidById.get(row.id),
    named(row.parent_id ?? ''),
    rank.get(row.id) ?? null,
    named(row.content),
    named(row.properties_json),
    named(row.references_json),
    row.deleted,
  ])).sort()
}

/** The uids on which two fixture states differ. */
export const differingUids = (a: readonly string[], b: readonly string[]): string[] => {
  const inA = new Set(a)
  const inB = new Set(b)
  const uid = (line: string) => (JSON.parse(line) as [string])[0]
  return [...new Set([...a.filter(line => !inB.has(line)), ...b.filter(line => !inA.has(line))].map(uid))]
}
