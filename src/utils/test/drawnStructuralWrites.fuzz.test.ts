// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view'
import fc from 'fast-check'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type DrawnChild, type NestedSurface } from '@/data/childrenView'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
const guard = statefulFuzzGuard()
const forest = fc.record({
  branches: fc.array(fc.nat(), {maxLength: 10}),
  order: fc.constantFrom('outline' as const, 'derived' as const, 'query' as const),
  ranks: fc.array(fc.integer(), {minLength: 4, maxLength: 4}),
  shared: fc.boolean(),
  occurrence: fc.nat(),
})
type Forest = typeof forest extends fc.Arbitrary<infer Input> ? Input : never
const gestures = ['indent', 'outdent', 'up', 'down', 'enter', 'split', 'above', 'below', 'merge', 'empty-merge', 'empty-enter'] as const
type Gesture = typeof gestures[number]

interface Row {
  id: string
  parent_id: string | null
  order_key: string
  deleted: number
}

const snapshot = async (repo: Repo) => new Map((await repo.db.getAll<Row>(
  "SELECT id, parent_id, order_key, deleted FROM blocks WHERE workspace_id = 'forest'",
)).map(row => [row.id, row]))

function within(rows: ReadonlyMap<string, Row>, id: string | null, root: string) {
  const visited = new Set<string>()
  for (let cursor = id; cursor !== null; cursor = rows.get(cursor)?.parent_id ?? null) {
    if (cursor === root) return true
    if (visited.has(cursor)) throw new Error('Cycle at ' + cursor)
    visited.add(cursor)
  }
  return false
}

async function checkGesture(input: Forest, gesture: Gesture, note?: string) {
  await resetTestDb(db.db)
  const panel = outlineSurfaceOf({scopeRootId: 'page', renderScopeId: 'outline'})!
  const parents = new Map<string, string | null>([
    ['page', null], ['ui', null], ['owner', 'page'], ['other-page', null],
    ['first', 'owner'], ['middle', 'owner'], ['outside', 'owner'],
    ['foreign', 'other-page'], ['untouched', 'other-page'], ['A', 'foreign'], ['B', 'foreign'],
    ['duplicate', 'B'], ['deeper', 'duplicate'],
  ])
  for (const [index, choice] of input.branches.entries()) {
    const candidates = [...parents.keys()].filter(id => !['page', 'ui'].includes(id))
    parents.set('extra-' + index, candidates[choice % candidates.length]!)
  }

  const dataOrder = ['first', 'middle', 'foreign', 'duplicate']
  const gridIds = input.order === 'outline' ? dataOrder
    : dataOrder.toSorted((a, b) => input.ranks[dataOrder.indexOf(a)]! - input.ranks[dataOrder.indexOf(b)]!)
  const grid: NestedSurface = {kind: 'nested-surface', renderScopeId: 'grid', order: input.order,
    scopeRootId: input.shared ? 'owner' : undefined, members: gridIds}
  const foreignSurface = {...panel, scopeRootId: 'foreign', renderScopeId: 'grid', scopeRootForcesOpen: false}
  const notes: NestedSurface = {kind: 'nested-surface', renderScopeId: 'notes', scopeRootId: 'foreign', order: 'outline',
    members: [...parents.keys()].filter(id => parents.get(id) === 'foreign')}
  const gridChildren: readonly DrawnChild[] = [grid, 'outside']
  const {repo} = createTestRepo({db: db.db, extensions: [
    surfaceOwnerFacet.of(({renderScopeId}) => {
      if (renderScopeId === 'grid') return {blockId: 'owner', surface: panel}
      if (renderScopeId === 'notes') return {blockId: 'foreign', surface: foreignSurface}
      return null
    }),
    childrenViewFacet.of(({parent, surface}) => {
      if (parent.id === 'owner') return {id: 'board', read: () => ({load: async () => gridChildren, peek: () => gridChildren})}
      if (parent.id === 'foreign' && surface.renderScopeId === 'grid') {
        return {id: 'notes', read: () => ({load: async () => [notes], peek: () => [notes]})}
      }
      return null
    }),
  ]})
  repo.setActiveWorkspaceId('forest')
  await repo.tx(async tx => {
    let n = 0
    for (const [id, parentId] of parents) await tx.create({
      id, workspaceId: 'forest', parentId, orderKey: 'a' + (n++).toString(36), content: 'block ' + id,
    })
  }, {scope: ChangeScope.BlockDefault})
  const before = await snapshot(repo)
  const occurrences = [
    ...gridIds.map(id => ({
      id, surface: {...foreignSurface, scopeRootId: input.shared ? 'owner' : id},
      boundary: parents.get(id) === 'owner' ? 'owner' : id, gridRow: true,
    })),
    ...[...parents.keys()].filter(id => id !== 'foreign' && within(before, id, 'foreign')).map(id => ({
      id, surface: {...foreignSurface, renderScopeId: 'notes'}, boundary: 'foreign', gridRow: false,
    })),
  ]
  const location = note ? occurrences.find(occurrence => occurrence.id === note && !occurrence.gridRow)!
    : occurrences[input.occurrence % occurrences.length]!
  const {id, surface, boundary} = location
  const deps = {block: repo.block(id), uiStateBlock: repo.block('ui'), ...surface}
  const trigger = new KeyboardEvent('keydown')
  if (gesture === 'above' || gesture === 'below') {
    const action = getVimNormalModeActions({repo}).find(action => action.id === 'create_block_' + gesture + '_and_edit')!
    await action.handler(deps, trigger)
  } else {
    const editActions = getDefaultActionGroups({repo}).editModeCMActions
    const action = editActions.find(action => action.id === ({
      indent: 'edit.cm.indent_block', outdent: 'edit.cm.outdent_block', up: 'move_block_up_cm', down: 'move_block_down_cm',
      enter: 'split_block_cm', split: 'split_block_cm', merge: 'delete_empty_block_cm',
      'empty-enter': 'split_block_cm', 'empty-merge': 'delete_empty_block_cm',
    })[gesture])!
    const doc = gesture.startsWith('empty-') ? '' : (await deps.block.load())!.content
    const editor = new EditorView({doc, selection: {anchor: gesture === 'merge' ? 0 : gesture === 'split' ? 1 : doc.length}})
    try {
      await action.handler({...deps, editorView: editor}, trigger)
    } finally {
      editor.destroy()
    }
  }

  const after = await snapshot(repo)
  const foreignRoot = location.gridRow && boundary === id
  const refusal = location.gridRow && (
    (['up', 'down'].includes(gesture) && input.order !== 'outline') ||
    (foreignRoot && ['indent', 'outdent', 'up', 'down', 'merge', 'empty-merge', 'split'].includes(gesture))
  )
  for (const [rowId, old] of before) {
    if (refusal || rowId === boundary || !within(before, rowId, id)) expect(after.get(rowId)).toEqual(old)
  }
  for (const [rowId, row] of after) {
    // Every new or relocated live row stays within the initiating occurrence's stored subtree.
    if (!row.deleted && (!before.has(rowId) || before.get(rowId)?.parent_id !== row.parent_id)) {
      expect(within(after, rowId, boundary), rowId + ' escaped ' + boundary).toBe(true)
    }
  }
  if (refusal) expect(after.size).toEqual(before.size)
  await repo.awaitReprojections()
  repo.setActiveWorkspaceId(null)
  return {before, after}
}

it.each(gestures)('%s confines structural writes to the drawn occurrence', async gesture => {
  await fc.assert(fc.asyncProperty(forest, input => guard.run(1, async () => {
    await checkGesture(input, gesture)
  })), fuzzParams(10))
}, fuzzTestTimeout())

const foreignNotes: Forest = {branches: [], order: 'query', ranks: [0, 1, 2, 3], shared: true, occurrence: 0}

it('Tab in a foreign result nests the second local note under the first', async () => {
  const {before, after} = await checkGesture(foreignNotes, 'indent', 'B')
  expect(before.get('B')?.parent_id).toBe('foreign')
  expect(after.get('B')?.parent_id).toBe('A')
})

it('Shift-Tab on the first note cannot lift it out of a foreign result', async () => {
  const {before, after} = await checkGesture(foreignNotes, 'outdent', 'A')
  expect(before.get('A')?.parent_id).toBe('foreign')
  expect(after).toEqual(before)
})

it('empty Backspace preserves a projected result and its children under a declared shared root', async () => {
  await checkGesture({branches: [], order: 'outline', ranks: [0, 1, 2, 3], shared: true, occurrence: 2}, 'empty-merge')
})
