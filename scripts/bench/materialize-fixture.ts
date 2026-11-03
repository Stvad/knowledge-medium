import type { BlockData } from '@/data/api'

export interface MaterializeFixture {
  readonly blocks: BlockData[]
  readonly expectedPlaintext: Map<string, BlockData>
  readonly aliasCount: number
  readonly referenceCount: number
  readonly fieldCount: number
  readonly fieldIds: Set<string>
}

export const MATERIALIZE_WORKSPACE_ID = 'bench-materialize-workspace'
export const MATERIALIZE_USER_ID = 'bench-materialize-user'
export const materializeFixtureId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
export const materializeFixtureAlias = (n: number) => `bench-alias-${n}`

/** Deterministic, browser-safe synthetic records shared by Node and WebKit benches. */
export const makeMaterializeFixture = (count: number): MaterializeFixture => {
  const blocks: BlockData[] = []
  const expectedPlaintext = new Map<string, BlockData>()
  let aliasCount = 0
  let referenceCount = 0
  let fieldCount = 0
  const fieldIds = new Set<string>()
  const baseTime = 1_800_000_000_000
  for (let i = 0; i < count; i++) {
    const id = materializeFixtureId(i + 1)
    const parentId = i > 0 && i % 11 !== 0 ? materializeFixtureId(Math.floor(i / 11) * 11 + 1) : null
    let content = `A realistic workspace paragraph ${i}: planning, notes, and a few ordinary words.`
    let properties: Record<string, unknown> = {tags: ['benchmark', `group-${i % 13}`], rank: i % 7}
    let references: BlockData['references'] = []
    if (i % 13 === 0) {
      properties = {alias: [materializeFixtureAlias(i)], title: `Page ${i}`, tags: ['benchmark', 'page']}
      aliasCount++
    } else if (i % 13 === 1) {
      const target = i - 1
      content = `[[${materializeFixtureAlias(target)}]]`
      references = [{id: materializeFixtureId(target + 1), alias: materializeFixtureAlias(target)}]
      referenceCount++
    } else if (i % 13 === 2) {
      const target = Math.max(0, i - 1)
      content = `((${materializeFixtureId(target + 1)}))`
      references = [{id: materializeFixtureId(target + 1), alias: materializeFixtureId(target + 1)}]
      referenceCount++
    } else if (i % 13 === 3) {
      const target = Math.max(0, i - 1)
      content = `[related](((${materializeFixtureId(target + 1)})))`
      references = [{id: materializeFixtureId(target + 1), alias: 'related'}]
      referenceCount++
    } else if (i % 13 === 4) {
      const target = Math.max(0, i - 1)
      content = `::[related](((${materializeFixtureId(target + 1)})))`
      properties = {field: 'related', value: [{id: materializeFixtureId(target + 1), alias: materializeFixtureAlias(target)}]}
      references = [{id: materializeFixtureId(target + 1), alias: materializeFixtureAlias(target)}]
      fieldCount++
      fieldIds.add(id)
      referenceCount++
    }
    const block: BlockData = {
      id, workspaceId: MATERIALIZE_WORKSPACE_ID, parentId, orderKey: `k${i.toString().padStart(7, '0')}`,
      content, properties, references,
      createdAt: baseTime + i, updatedAt: baseTime + i, userUpdatedAt: baseTime + i,
      createdBy: MATERIALIZE_USER_ID, updatedBy: MATERIALIZE_USER_ID, deleted: false,
    }
    blocks.push(block)
    expectedPlaintext.set(id, block)
  }
  return {blocks, expectedPlaintext, aliasCount, referenceCount, fieldCount, fieldIds}
}
