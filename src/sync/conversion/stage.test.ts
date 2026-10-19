import { describe, expect, it } from 'vitest'
import type { WorkspaceConversionState } from '../keys/conversionState.js'
import { stageMovedBack, stageOf } from './stage.js'

const USER = 'user-1'
const read = (state: Partial<WorkspaceConversionState>) => ({
  kind: 'read' as const,
  state: {encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: USER, ...state},
})

describe('stageOf', () => {
  it('maps the server row to the run it calls for', () => {
    expect(stageOf(read({}), USER)).toEqual({kind: 'stage', stage: {kind: 'plaintext'}})
    expect(stageOf(read({encryptionMode: 'e2ee', wkCanary: 'c', conversionPhase: 'sealing'}), USER))
      .toEqual({kind: 'stage', stage: {kind: 'sealing', canary: 'c'}})
    expect(stageOf(read({encryptionMode: 'e2ee', wkCanary: 'c', conversionPhase: 'cleaning'}), USER))
      .toEqual({kind: 'stage', stage: {kind: 'cleaning', canary: 'c'}})
    expect(stageOf(read({encryptionMode: 'e2ee', wkCanary: 'c'}), USER)).toEqual({kind: 'stage', stage: {kind: 'done'}})
  })

  it('runs nothing for a member who is not the owner', () => {
    expect(stageOf(read({ownerUserId: 'someone-else'}), USER)).toEqual({kind: 'not-owner'})
  })

  it('runs nothing on a row the flip never writes', () => {
    expect(stageOf(read({encryptionMode: 'e2ee', conversionPhase: 'sealing'}), USER)).toMatchObject({kind: 'unexpected'})
    expect(stageOf(read({conversionPhase: 'sealing'}), USER)).toMatchObject({kind: 'unexpected'})
    expect(stageOf(read({encryptionMode: 'something-new'}), USER)).toMatchObject({kind: 'unexpected'})
  })

  it('passes on a read that saw nothing', () => {
    expect(stageOf({kind: 'unavailable', error: new Error('offline')}, USER)).toEqual({kind: 'unavailable'})
    expect(stageOf({kind: 'not-visible'}, USER)).toEqual({kind: 'not-visible'})
  })
})

describe('stageMovedBack', () => {
  it('only moves forward', () => {
    expect(stageMovedBack({kind: 'sealing', canary: 'c'}, {kind: 'plaintext'})).toBe(true)
    expect(stageMovedBack({kind: 'cleaning', canary: 'c'}, {kind: 'sealing', canary: 'c'})).toBe(true)
    expect(stageMovedBack({kind: 'sealing', canary: 'c'}, {kind: 'sealing', canary: 'c'})).toBe(false)
    expect(stageMovedBack({kind: 'plaintext'}, {kind: 'done'})).toBe(false)
  })
})
