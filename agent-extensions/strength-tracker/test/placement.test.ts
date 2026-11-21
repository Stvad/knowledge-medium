import {describe, expect, it} from 'vitest'

import {placeAtFocus, placeOnPage, type FocusRow} from '../src/ui/placement'

const focus = (over: Partial<FocusRow> = {}): FocusRow => ({
  id: 'focused', parentId: 'page', content: '', orderKey: 'a3', hasChildren: false,
  properties: {}, ...over,
})

describe('placeOnPage', () => {
  it('puts the newest session on top, because the page reads as a log', () => {
    expect(placeOnPage('log-page')).toEqual({parentId: 'log-page', position: {kind: 'first'}})
  })
})

describe('placeAtFocus', () => {
  it('takes an empty line\'s place, keeping its slot', () => {
    // The line you just opened with Enter. Its `orderKey` travels so the
    // session lands exactly there rather than merely on the same parent.
    expect(placeAtFocus(focus())).toEqual({
      parentId: 'page',
      position: {kind: 'last'},
      replaces: {id: 'focused', orderKey: 'a3'},
    })
  })

  it('treats whitespace as empty', () => {
    expect(placeAtFocus(focus({content: '   '})).replaces).toEqual({id: 'focused', orderKey: 'a3'})
  })

  it('becomes a child of a block that says something', () => {
    expect(placeAtFocus(focus({content: 'Tuesday'}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of an empty block that already holds things', () => {
    // An empty block WITH children is a heading you are pointing at, not a
    // slot you opened — replacing it would delete whatever hangs off it.
    expect(placeAtFocus(focus({hasChildren: true}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of a blank block that carries a type', () => {
    // An empty todo, a property-schema definition, a header block — plenty of
    // records have blank content by design, and taking a line's place DELETES
    // it. Types are stored in the property bag, so this is the same question.
    expect(placeAtFocus(focus({properties: {types: '["todo"]'}}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of a blank block that carries any property at all', () => {
    // Not just types: a blank block holding `status`, or a Roam-imported
    // property, is somebody's record whatever it renders as.
    expect(placeAtFocus(focus({properties: {status: 'open'}})).replaces).toBeUndefined()
  })

  it('never replaces a page, however empty its title', () => {
    // There is nowhere else to put the session, and deleting a page because
    // you ran a command on it is not a trade anyone wants.
    expect(placeAtFocus(focus({parentId: null}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })
})
