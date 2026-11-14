import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import {commitInlineProperty} from '@/data/inlineProperty'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {OutlinePropertySession} from './outlinePropertySession'

vi.mock('@/data/inlineProperty', () => ({commitInlineProperty: vi.fn()}))
beforeEach(() => { vi.mocked(commitInlineProperty).mockReset() })

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
      field: {pending: [{schema, fieldRowId: 'row', ownerId: 'owner', parentId: 'row', autoFocus: true}], revealed: []},
    }])
  })

  it('returns an emptied listing to the shared empty snapshot', () => {
    const session = new OutlinePropertySession()
    const empty = session.snapshot('absent')
    session.add('owner', {schema})
    session.remove('owner', schema.fieldId)
    expect(session.snapshot('owner')).toBe(empty)
  })

  it('retains text and its containing field while expiring empty sibling drafts', () => {
    const session = new OutlinePropertySession()
    session.add('owner', {schema, fieldRowId: 'row'})
    session.setText(session.snapshot('row').pending[0]!, 'text')
    session.add('owner', {schema: {...schema, fieldId: 'empty'}})
    session.reveal('owner', 'saved-row')
    session.clearOwner('owner')
    expect(session.snapshot('owner')).toEqual({pending: [], revealed: ['row']})
    expect(session.snapshot('row').pending).toHaveLength(1)
    session.setText(session.snapshot('row').pending[0]!, '')
    session.clearOwner('owner')
    expect(session.snapshot('owner')).toEqual({pending: [], revealed: []})
    expect(session.snapshot('row').pending).toHaveLength(0)
  })

  it('keeps ghost text when Add field selects the same definition', () => {
    const session = new OutlinePropertySession()
    session.setText({schema, ownerId: 'owner', parentId: 'owner'}, 'uncommitted text')
    session.add('owner', {schema})
    expect(session.snapshot('owner').pending[0]?.text).toBe('uncommitted text')
  })

  it('clears departing owner entries and returns unsaved text for a visible warning', () => {
    const session = new OutlinePropertySession()
    session.setText({schema, ownerId: 'owner', parentId: 'row', fieldRowId: 'row'}, 'keep me visible')
    session.setText({schema, ownerId: 'other', parentId: 'other'}, 'other text')
    expect(session.snapshot('owner').revealed).toEqual(['row'])
    expect(session.disposeOwner('owner').map(row => row.text)).toEqual(['keep me visible'])
    expect(session.snapshot('owner').revealed).toEqual([])
    expect(session.snapshot('owner').pending).toEqual([])
    expect(session.snapshot('row').pending).toEqual([])
    expect(session.snapshot('other').pending[0]?.text).toBe('other text')
  })

  it('publishes text changes but not an unchanged draft', () => {
    const session = new OutlinePropertySession()
    session.add('owner', {schema})
    const changed = vi.fn()
    session.subscribe(changed)
    session.setText(session.snapshot('owner').pending[0]!, 'text')
    expect(changed).toHaveBeenCalledOnce()
    session.setText(session.snapshot('owner').pending[0]!, 'text')
    expect(changed).toHaveBeenCalledOnce()
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

describe('session-owned draft submission', () => {
  const owner = {} as Block
  const draft = {schema, ownerId: 'owner', parentId: 'owner'}
  it('does not submit an absent or empty draft', async () => {
    const session = new OutlinePropertySession()
    expect(await session.submit(owner, draft)).toBeNull()
    session.add('owner', {schema})
    expect(await session.submit(owner, draft)).toBeNull()
    expect(commitInlineProperty).not.toHaveBeenCalled()
  })
  it('keeps one in-flight write and its text through remounts', async () => {
    const session = new OutlinePropertySession()
    session.setText(draft, 'one member')
    let finish = () => {}
    vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({fieldRowId: 'field-row', valueId: 'value'})
    }))
    const save = session.submit(owner, draft)
    expect(session.snapshot('owner').pending[0]?.committing).toBe(true)
    session.setText(draft, 'cannot overwrite a submitting draft')
    expect(session.snapshot('owner').pending[0]?.text).toBe('one member')
    expect(await session.submit(owner, draft)).toBeNull()
    expect(commitInlineProperty).toHaveBeenCalledOnce()
    finish()
    await save
    expect(session.snapshot('owner').pending).toEqual([])
  })
  it('returns a rejected draft to editing without losing its text', async () => {
    const session = new OutlinePropertySession()
    session.setText(draft, 'invalid value')
    vi.mocked(commitInlineProperty).mockRejectedValue(new Error('invalid'))
    await expect(session.submit(owner, draft)).rejects.toThrow('invalid')
    expect(session.snapshot('owner').pending[0]).toMatchObject({text: 'invalid value', committing: false})
  })
  it('does not remove a new draft when an unmounted owner save completes', async () => {
    const session = new OutlinePropertySession()
    session.setText(draft, 'old value')
    let finish = () => {}
    vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({fieldRowId: 'field-row', valueId: 'value'})
    }))
    const save = session.submit(owner, draft)
    session.disposeOwner('owner')
    session.setText(draft, 'new unsaved value')
    finish()
    await save
    expect(session.snapshot('owner').pending[0]?.text).toBe('new unsaved value')
  })
})
