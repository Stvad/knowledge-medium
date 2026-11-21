// @vitest-environment node
import {expect, it, vi} from 'vitest'
import type {BlockData} from '@/data/api'
import type {TxDb} from '@/data/internals/txEngine'
import type {MaterializeDeps, SyncSnapshot} from './materialize'
import {deriveReferenceTargetsAtArrival} from './arrivalProcessors'

const block = (id: string, content: string): BlockData => ({
  id, content, workspaceId: 'ws', parentId: null, orderKey: id, properties: {}, references: [],
  createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'peer', updatedBy: 'peer',
  deleted: false, referenceTargetId: null, isFieldForm: false,
})
const snapshotsWith = (...contents: string[]) => new Map<string, SyncSnapshot>(
  contents.map((content, i) => [String(i), {before: null, after: block(String(i), content)}]),
)
const fakeTx = (source: {value: string | null} = {value: null}): TxDb => ({
  execute: vi.fn(async () => undefined), getAll: async () => [],
  get: async () => { throw new Error('unused') },
  getOptional: async () => ({source: source.value}),
} as unknown as TxDb)
const deps = (lookup: NonNullable<MaterializeDeps['referenceTargetLookups']>): MaterializeDeps => ({
  getMaterializability: () => 'copy', getCek: async () => null, referenceTargetLookups: lookup,
})

it('refuses a lookup that stamps tx_context.source, even when that row throws', async () => {
  const source = {value: null as string | null}
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await expect(deriveReferenceTargetsAtArrival(fakeTx(source), snapshotsWith('[[bad]]'), deps(() => ({
      aliasTargetId: async () => { source.value = 'user'; throw new Error('bad lookup') },
    })))).rejects.toThrow(/left tx_context.source/)
  } finally { warning.mockRestore() }
})

it('stamps both local columns and the invalidation snapshots together', async () => {
  const snapshots = snapshotsWith('::((target))', 'plain', '[[Alias]]')
  const quarantined = await deriveReferenceTargetsAtArrival(fakeTx(), snapshots, deps(() => ({
    aliasTargetId: async () => 'alias-target',
  })))
  expect(quarantined).toEqual([])
  expect(snapshots.get('0')?.after).toMatchObject({referenceTargetId: 'target', isFieldForm: true})
  expect(snapshots.get('1')?.after).toMatchObject({referenceTargetId: null, isFieldForm: false})
  expect(snapshots.get('2')?.after).toMatchObject({referenceTargetId: 'alias-target', isFieldForm: false})
})

it('isolates a throwing lookup and preserves that row while deriving later rows', async () => {
  const snapshots = snapshotsWith('[[Good]]', '[[Bad]]', '::((later))')
  snapshots.set('1', {...snapshots.get('1')!, before: {...block('1', '((old-target))'), referenceTargetId: 'old-target'}})
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await deriveReferenceTargetsAtArrival(fakeTx(), snapshots, deps(() => ({
      aliasTargetId: async alias => { if (alias === 'Bad') throw new Error('poison'); return 'good-target' },
    })))).toEqual(['1'])
    expect(snapshots.get('0')?.after?.referenceTargetId).toBe('good-target')
    expect(snapshots.get('1')?.after?.referenceTargetId).toBe('old-target')
    expect(snapshots.get('2')?.after?.referenceTargetId).toBe('later')
  } finally { warning.mockRestore() }
})

it('quarantines malformed content during preparation without starving other rows', async () => {
  const snapshots = snapshotsWith('::((good))', null as unknown as string, '((later))')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await deriveReferenceTargetsAtArrival(fakeTx(), snapshots, deps(() => ({aliasTargetId: async () => null})))).toEqual(['1'])
    expect(snapshots.get('0')?.after?.referenceTargetId).toBe('good')
    expect(snapshots.get('1')?.after?.referenceTargetId).toBeNull()
    expect(snapshots.get('2')?.after?.referenceTargetId).toBe('later')
  } finally { warning.mockRestore() }
})

it('does not construct lookups for absent dependencies, empty windows, or removed-only snapshots', async () => {
  const lookup = vi.fn(() => ({aliasTargetId: async () => null}))
  const tx = fakeTx()
  await deriveReferenceTargetsAtArrival(tx, snapshotsWith('((id))'), {} as MaterializeDeps)
  await deriveReferenceTargetsAtArrival(tx, new Map(), deps(lookup))
  await deriveReferenceTargetsAtArrival(tx, new Map([['gone', {before: block('gone', 'x'), after: null}]]), deps(lookup))
  expect(lookup).not.toHaveBeenCalled()
  expect(tx.execute).not.toHaveBeenCalled()
})

it('preserves local columns on content-unchanged arrivals without resolving aliases', async () => {
  const snapshots = snapshotsWith('::[[Old]]')
  snapshots.set('0', {...snapshots.get('0')!, before: {...block('0', '::[[Old]]'), referenceTargetId: 'retained', isFieldForm: true}})
  const aliasTargetId = vi.fn(async () => null)
  const tx = fakeTx()
  await deriveReferenceTargetsAtArrival(tx, snapshots, deps(() => ({aliasTargetId})))
  expect(aliasTargetId).not.toHaveBeenCalled()
  expect(tx.execute).not.toHaveBeenCalled()
  expect(snapshots.get('0')?.after).toMatchObject({referenceTargetId: 'retained', isFieldForm: true})
})

it('falls back from failed bulk reads and caches each alias per workspace only within the window', async () => {
  const aliasTargetId = vi.fn(async (_alias: string, ws: string) => `${ws}-target`)
  const aliasTargetIds = vi.fn(async () => { throw new Error('batch read failed') })
  const snapshots = snapshotsWith('[[Same]]', '::[[Same]]', '[[Same]]')
  snapshots.get('2')!.after!.workspaceId = 'other'
  const lookup = deps(() => ({aliasTargetId, aliasTargetIds}))
  expect(await deriveReferenceTargetsAtArrival(fakeTx(), snapshots, lookup)).toEqual([])
  expect(aliasTargetIds).toHaveBeenCalledTimes(2)
  expect(aliasTargetId).toHaveBeenCalledTimes(2)
  expect(snapshots.get('0')?.after?.referenceTargetId).toBe('ws-target')
  expect(snapshots.get('2')?.after?.referenceTargetId).toBe('other-target')
  await deriveReferenceTargetsAtArrival(fakeTx(), snapshotsWith('[[Same]]'), lookup)
  expect(aliasTargetId).toHaveBeenCalledTimes(3)
})
