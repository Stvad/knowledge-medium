import {describe, expect, it, vi} from 'vitest'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {OutlinePropertySession} from './outlinePropertySession'

const schema = {fieldId: 'field', name: 'test:field'} as AnyResolvedPropertySchema

describe('outline property session publications', () => {
  it('leaves an untouched ghost cancellation and absent owner exit inert', () => {
    const session = new OutlinePropertySession()
    const empty = session.snapshot('owner')
    const changed = vi.fn()
    session.subscribe(changed)
    session.remove('owner', schema.fieldId)
    session.clearOwner('owner')
    expect(session.snapshot('owner')).toBe(empty)
    expect(changed).not.toHaveBeenCalled()
  })

  it('publishes a list member and its owner reveal together', () => {
    const session = new OutlinePropertySession()
    const snapshots: unknown[] = []
    session.subscribe(() => snapshots.push({owner: session.snapshot('owner'), field: session.snapshot('row')}))
    session.add('owner', {schema, fieldRowId: 'row'})
    expect(snapshots).toEqual([{
      owner: {pending: [], revealed: ['row']},
      field: {pending: [{schema, fieldRowId: 'row', ownerId: 'owner', parentId: 'row'}], revealed: []},
    }])
  })

  it('returns an emptied listing to the shared empty snapshot', () => {
    const session = new OutlinePropertySession()
    const empty = session.snapshot('absent')
    session.add('owner', {schema})
    session.remove('owner', schema.fieldId)
    expect(session.snapshot('owner')).toBe(empty)
  })

  it('clears only the departing owner, including pending members under its field', () => {
    const session = new OutlinePropertySession()
    const empty = session.snapshot('absent')
    session.add('owner', {schema, fieldRowId: 'row'})
    session.add('other', {schema, fieldRowId: 'other-row'})
    const other = session.snapshot('other')
    const otherRow = session.snapshot('other-row')
    const changed = vi.fn()
    session.subscribe(changed)
    session.clearOwner('owner')
    expect(changed).toHaveBeenCalledOnce()
    expect(session.snapshot('owner')).toBe(empty)
    expect(session.snapshot('row')).toBe(empty)
    expect(session.snapshot('other')).toBe(other)
    expect(session.snapshot('other-row')).toBe(otherRow)
    changed.mockClear()
    session.clearOwner('owner')
    expect(changed).not.toHaveBeenCalled()
  })
})
