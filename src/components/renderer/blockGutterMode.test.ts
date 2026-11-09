import { describe, expect, it } from 'vitest'
import {
  decideGutterTopMode,
  INITIAL_GUTTER_TOP_STATE,
  type GutterTopMeasure,
  type GutterTopState,
} from './blockGutterMode'

const atCorner = (key = 'k1'): GutterTopMeasure => ({hasText: true, topGap: 0, rightGap: 0, key})

describe('decideGutterTopMode', () => {
  it('has nothing to choose without registered text', () => {
    expect(decideGutterTopMode(INITIAL_GUTTER_TOP_STATE, {hasText: false, topGap: 0, rightGap: 0, key: 'k1'}).mode)
      .toBe('none')
  })

  it('lets text that starts at the corner flow around it', () => {
    expect(decideGutterTopMode(INITIAL_GUTTER_TOP_STATE, atCorner()).mode).toBe('flow')
  })

  it('narrows the content when something sits beside the text', () => {
    const next = decideGutterTopMode({mode: 'flow', stuckKey: null}, {...atCorner(), rightGap: 40})
    expect(next).toEqual({mode: 'column', stuckKey: 'k1'})
  })

  it('narrows the content when something sits above the text', () => {
    expect(decideGutterTopMode(INITIAL_GUTTER_TOP_STATE, {...atCorner(), topGap: 224}).mode).toBe('column')
  })

  it('stays in column for the sizes that made it leave flow', () => {
    const stuck: GutterTopState = {mode: 'column', stuckKey: 'k1'}
    expect(decideGutterTopMode(stuck, atCorner('k1'))).toEqual(stuck)
  })

  it('tries flow again once the sizes change', () => {
    expect(decideGutterTopMode({mode: 'column', stuckKey: 'k1'}, atCorner('k2')).mode).toBe('flow')
  })

  it('settles when the text only reaches the corner while the content is narrowed', () => {
    // Text that shrinks to fit and has the spacer inside it measures
    // differently in each mode: it reaches the corner in column mode and
    // falls short of it in flow mode.
    const measureIn = (mode: GutterTopState['mode']): GutterTopMeasure =>
      mode === 'flow' ? {...atCorner(), rightGap: 20} : atCorner()

    let state = INITIAL_GUTTER_TOP_STATE
    const modes: string[] = []
    for (let pass = 0; pass < 10; pass++) {
      state = decideGutterTopMode(state, measureIn(state.mode))
      modes.push(state.mode)
    }

    expect(modes.slice(2).every(mode => mode === 'column')).toBe(true)
  })
})
