import {describe, expect, it} from 'vitest'

import {placeAtFocus, placeOnPage, type FocusRow} from '../src/ui/placement'

const focus = (over: Partial<FocusRow> = {}): FocusRow => ({
  id: 'focused', parentId: 'page', content: '', orderKey: 'a3', hasChildren: false,
  properties: {}, ...over,
})

describe('placeOnPage', () => {
  it('puts the newest experiment on top, because the page reads as a log', () => {
    expect(placeOnPage('lab-page')).toEqual({parentId: 'lab-page', position: {kind: 'first'}})
  })
})

describe('placeAtFocus', () => {
  it('files beside an empty line, as the last child of its parent, leaving the line', () => {
    // Unlike the Strength Tracker's placement, this never takes the line's
    // exact slot — see the module doc for why.
    expect(placeAtFocus(focus())).toEqual({parentId: 'page', position: {kind: 'last'}})
  })

  it('treats whitespace as empty', () => {
    expect(placeAtFocus(focus({content: '   '}))).toEqual({parentId: 'page', position: {kind: 'last'}})
  })

  it('becomes a child of a block that says something', () => {
    expect(placeAtFocus(focus({content: 'Protocol'}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of an empty block that already holds things', () => {
    // An empty block WITH children is a heading you are pointing at, not a
    // slot you opened — filing beside it would strand it under nothing.
    expect(placeAtFocus(focus({hasChildren: true}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of a blank block that carries a type', () => {
    // An empty todo, a property-schema definition, a header block — plenty of
    // records have blank content by design. Types are stored in the property
    // bag, so this is the same question `isExpendableLine` asks.
    expect(placeAtFocus(focus({properties: {types: ['sleeplab-experiment']}}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('becomes a child of a blank block that carries any property at all', () => {
    expect(placeAtFocus(focus({properties: {status: 'open'}}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })

  it('never treats a page as expendable, however empty its title', () => {
    // There is nowhere else to put the experiment, and deleting a page (or,
    // here, quietly filing beside it) because you ran a command on it is not
    // a trade anyone wants.
    expect(placeAtFocus(focus({parentId: null}))).toEqual({
      parentId: 'focused', position: {kind: 'first'},
    })
  })
})
