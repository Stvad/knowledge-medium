// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createKeybindingsHandler } from 'tinykeys'
import { createSequenceMatcher } from './sequenceMatcher.ts'

const press = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', init)

/** `timeStamp` is browser-set and ignored by KeyboardEventInit in jsdom, so
 *  stamp it explicitly for the sequence-timeout cases. */
const pressAt = (init: KeyboardEventInit, timeStamp: number): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', init)
  Object.defineProperty(event, 'timeStamp', {configurable: true, value: timeStamp})
  return event
}

/** Whether tinykeys' own handler fires for `chord` given `events` — the
 *  incumbent this matcher must agree with on the dispatch path. `ignore` is
 *  disabled to match the coordinator's `makeMatcher`. */
const tinykeysFires = (chord: string, events: readonly KeyboardEvent[]): boolean => {
  let fired = false
  const handler = createKeybindingsHandler({[chord]: () => { fired = true }}, {ignore: () => false})
  for (const event of events) handler(event)
  return fired
}

/** Feed `events` through a fresh matcher; whether ANY event completed it. */
const matcherFires = (chord: string, events: readonly KeyboardEvent[]): boolean => {
  const matcher = createSequenceMatcher(chord)
  let fired = false
  for (const event of events) {
    if (matcher.next(event).completed) fired = true
  }
  return fired
}

describe('createSequenceMatcher ↔ tinykeys parity', () => {
  // Real keyboard events always carry `code`; tinykeys' handler drops events
  // without one, so the synthesized events do too. `fires` pins the expected
  // direction so a matched double-failure can't pass as "agreement".
  const CASES: Array<{name: string; chord: string; events: KeyboardEventInit[]; fires: boolean}> = [
    {name: '$mod on Ctrl', chord: '$mod+k', events: [{key: 'k', code: 'KeyK', ctrlKey: true}], fires: true},
    {name: '$mod rejects Meta off-Mac', chord: '$mod+k', events: [{key: 'k', code: 'KeyK', metaKey: true}], fires: false},
    {name: 'literal Control', chord: 'Control+d', events: [{key: 'd', code: 'KeyD', ctrlKey: true}], fires: true},
    {name: 'shifted glyph via code', chord: 'Control+Shift+Backquote', events: [{key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true}], fires: true},
    {name: 'Shift+? matches', chord: 'Shift+?', events: [{key: '?', code: 'Slash', shiftKey: true}], fires: true},
    {name: 'bare ? rejects Shift', chord: '?', events: [{key: '?', code: 'Slash', shiftKey: true}], fires: false},
    {name: 'extra modifier rejected', chord: 'g', events: [{key: 'g', code: 'KeyG', ctrlKey: true}], fires: false},
    {name: 'Space', chord: 'Space', events: [{key: ' ', code: 'Space'}], fires: true},
    {name: 'sequence completes', chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'g', code: 'KeyG'}], fires: true},
    {name: 'sequence broken', chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'h', code: 'KeyH'}], fires: false},
    {name: 'sequence not yet complete', chord: 'g g', events: [{key: 'g', code: 'KeyG'}], fires: false},
    {name: 'partial then fresh restart completes', chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'h', code: 'KeyH'}, {key: 'g', code: 'KeyG'}, {key: 'g', code: 'KeyG'}], fires: true},
    {name: 'modifier press does not break sequence', chord: 'g g', events: [{key: 'g', code: 'KeyG'}, {key: 'Shift', code: 'ShiftLeft', shiftKey: true}, {key: 'g', code: 'KeyG'}], fires: true},
    {name: 'first press wrong, no fire', chord: 'g g', events: [{key: 'x', code: 'KeyX'}, {key: 'g', code: 'KeyG'}], fires: false},
  ]

  it.each(CASES)('agrees with tinykeys: $name', ({chord, events, fires}) => {
    const pressed = events.map(press)
    expect(matcherFires(chord, pressed)).toBe(fires)
    // Guard against matched double-failure: tinykeys must agree on direction.
    expect(tinykeysFires(chord, pressed)).toBe(fires)
  })
})

describe('createSequenceMatcher verdicts', () => {
  it('reports pending mid-sequence, then completed', () => {
    const matcher = createSequenceMatcher('g g')
    expect(matcher.next(press({key: 'g', code: 'KeyG'}))).toEqual({completed: false, pending: true})
    expect(matcher.next(press({key: 'g', code: 'KeyG'}))).toEqual({completed: true, pending: false})
  })

  it('resets an alternative that misses but matches a later fresh start', () => {
    const matcher = createSequenceMatcher('g g')
    matcher.next(press({key: 'g', code: 'KeyG'}))          // pending
    expect(matcher.next(press({key: 'x', code: 'KeyX'}))).toEqual(NO_VERDICT) // broke, fresh
    matcher.next(press({key: 'g', code: 'KeyG'}))          // pending again
    expect(matcher.next(press({key: 'g', code: 'KeyG'})).completed).toBe(true)
  })

  it('matches any of several chord alternatives', () => {
    const matcher = createSequenceMatcher(['Shift+?', '?'])
    expect(matcher.next(press({key: '?', code: 'Slash', shiftKey: true})).completed).toBe(true)
    expect(matcher.next(press({key: '?', code: 'Slash'})).completed).toBe(true)
  })

  it('abandons an in-flight sequence after the timeout gap', () => {
    const matcher = createSequenceMatcher('g g', {timeoutMs: 1000})
    expect(matcher.next(pressAt({key: 'g', code: 'KeyG'}, 0)).pending).toBe(true)
    // A second `g` past the gap starts fresh (pending), it does not complete.
    expect(matcher.next(pressAt({key: 'g', code: 'KeyG'}, 2000))).toEqual({completed: false, pending: true})
  })

  it('holds a sequence indefinitely with an infinite timeout (inspector mode)', () => {
    const matcher = createSequenceMatcher('g g', {timeoutMs: Infinity})
    expect(matcher.next(pressAt({key: 'g', code: 'KeyG'}, 0)).pending).toBe(true)
    expect(matcher.next(pressAt({key: 'g', code: 'KeyG'}, 10_000)).completed).toBe(true)
  })

  it('reset() abandons progress', () => {
    const matcher = createSequenceMatcher('g g')
    matcher.next(press({key: 'g', code: 'KeyG'}))
    matcher.reset()
    // Without the earlier `g`, a lone `g` is only pending, not complete.
    expect(matcher.next(press({key: 'g', code: 'KeyG'}))).toEqual({completed: false, pending: true})
  })
})

const NO_VERDICT = {completed: false, pending: false}
