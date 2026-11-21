// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

const raw = async (id: string, parent: string | null, order: string, options: {
  content?: string; properties?: Record<string, unknown>; field?: boolean; target?: string; deleted?: boolean; workspace?: string
} = {}) => {
  await db.db.writeTransaction(async tx => {
    await tx.execute(`INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted, is_field_form, reference_target_id)
      VALUES (?, ?, ?, ?, ?, ?, '[]', 1, 1, 1, 'u', 'u', ?, ?, ?)`,
    [id, options.workspace ?? 'ws', parent, order, options.content ?? '', JSON.stringify(options.properties ?? {}),
      options.deleted ? 1 : 0, options.field ? 1 : null, options.target ?? null])
  })
}

describe('core.propertyCell', () => {
  it('returns field groups and value rows in projection order with the stored owner', async () => {
    await raw('definition', null, 'a', {properties: {types: ['property-schema']}})
    await raw('owner', null, 'a', {properties: {sample: 'fallback'}})
    await raw('field-b', 'owner', 'b', {field: true, target: 'definition'})
    await raw('field-a', 'owner', 'a', {field: true, target: 'definition'})
    await raw('value-b', 'field-a', 'b', {content: 'same'})
    await raw('value-a', 'field-a', 'a', {content: 'same'})
    await raw('foreign-value', 'field-a', 'b', {workspace: 'other'})
    await raw('nested-field', 'field-a', 'c', {field: true, target: 'definition'})
    await raw('deleted', 'field-a', 'd', {deleted: true})
    await raw('other', 'owner', 'c', {target: 'definition'})
    await raw('foreign', 'owner', 'd', {workspace: 'other', field: true, target: 'definition'})
    const {repo} = createTestRepo({db: db.db, user: {id: 'u'}})
    const result = await repo.query.propertyCell({ownerId: 'owner', fieldId: 'definition'}).load()
    expect(result.owner?.properties.sample).toBe('fallback')
    expect(result.fields.map(group => [group.field.id, group.values.map(value => value.id)]))
      .toEqual([['field-a', ['value-a', 'value-b']], ['field-b', []]])
  })

  it('reacts to definition recognition and owner fallback changes', async () => {
    await raw('definition', null, 'a')
    await raw('owner', null, 'a', {properties: {sample: 'old'}})
    await raw('field', 'owner', 'a', {field: true, target: 'definition'})
    const {repo} = createTestRepo({db: db.db, user: {id: 'u'}})
    const handle = repo.query.propertyCell({ownerId: 'owner', fieldId: 'definition'})
    const unsubscribe = handle.subscribe(() => {})
    try {
      expect((await handle.load()).fields).toEqual([])
      await repo.tx(tx => tx.update('definition', {properties: {types: ['property-schema']}}), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()?.fields.map(group => group.field.id)).toEqual(['field']))
      await repo.tx(tx => tx.update('owner', {properties: {sample: 'new'}}), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()?.owner?.properties.sample).toBe('new'))
    } finally { unsubscribe() }
  })

  it('reacts when an existing ordinary child becomes a field and its value changes', async () => {
    await raw('definition', null, 'a', {properties: {types: ['property-schema']}})
    await raw('owner', null, 'a')
    await raw('candidate', 'owner', 'a')
    await raw('value', 'candidate', 'a', {content: 'before'})
    const {repo} = createTestRepo({db: db.db, user: {id: 'u'}})
    const handle = repo.query.propertyCell({ownerId: 'owner', fieldId: 'definition'})
    const unsubscribe = handle.subscribe(() => {})
    try {
      expect((await handle.load()).fields).toEqual([])
      await repo.tx(async tx => { await tx.update('candidate', {content: '::((definition))'}) }, {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()?.fields[0]?.values[0]?.content).toBe('before'))
      await repo.tx(async tx => { await tx.update('value', {content: 'after'}) }, {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()?.fields[0]?.values[0]?.content).toBe('after'))
    } finally { unsubscribe() }
  })

  it('does not invalidate for unrelated sibling or nested field edits', async () => {
    await raw('definition', null, 'a', {properties: {types: ['property-schema']}})
    await raw('owner', null, 'a')
    await raw('field', 'owner', 'a', {field: true, target: 'definition'})
    await raw('nested', 'field', 'a', {field: true, target: 'definition'})
    await raw('sibling', 'owner', 'b')
    const {repo} = createTestRepo({db: db.db, user: {id: 'u'}})
    const handle = repo.query.propertyCell({ownerId: 'owner', fieldId: 'definition'})
    const unsubscribe = handle.subscribe(() => {})
    try {
      expect((await handle.load()).fields[0]?.values).toEqual([])
      const before = repo.handleStore.metrics.loaderInvalidations
      await repo.tx(tx => tx.update('sibling', {content: 'ordinary edit'}), {scope: ChangeScope.BlockDefault})
      await repo.tx(tx => tx.update('nested', {properties: {sample: 'edit'}}), {scope: ChangeScope.BlockDefault})
      expect(repo.handleStore.metrics.loaderInvalidations).toBe(before)
      await repo.tx(tx => tx.update('field', {properties: {sample: 'edit'}}), {scope: ChangeScope.BlockDefault})
      expect(repo.handleStore.metrics.loaderInvalidations).toBeGreaterThan(before)
    } finally { unsubscribe() }
  })
})
