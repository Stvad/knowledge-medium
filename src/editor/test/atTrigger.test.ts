import { describe, expect, it } from 'vitest'
import { matchBareAt, matchMentionTrigger, matchPlaceTrigger } from '../atTrigger'

const owners = (text: string, pos = text.length) => ({
  bare: matchBareAt(text, pos),
  mention: matchMentionTrigger(text, pos),
  place: matchPlaceTrigger(text, pos),
})

describe('the @ trigger family', () => {
  it('a bare @ belongs only to the places hand-off', () => {
    expect(owners('ask @')).toEqual({bare: {from: 4, query: ''}, mention: null, place: null})
  })

  it('@query belongs only to contributor mentions', () => {
    expect(owners('ask @cl')).toEqual({bare: null, mention: {from: 4, query: 'cl'}, place: null})
  })

  it('@@ and @@query belong only to places, spanning both chars', () => {
    expect(owners('ask @@')).toEqual({bare: null, mention: null, place: {from: 4, query: ''}})
    expect(owners('ask @@cl')).toEqual({bare: null, mention: null, place: {from: 4, query: 'cl'}})
  })
})
