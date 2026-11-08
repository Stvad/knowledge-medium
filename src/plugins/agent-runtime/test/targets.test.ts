import { describe, expect, it } from 'vitest'
import { parseAgentTarget } from '../targets'

const ID = '3f2a9c1b-0000-4000-8000-000000000001'

describe('parseAgentTarget', () => {
  it('reads [[Name]] as a page name, trimmed', () => {
    expect(parseAgentTarget('[[ Project Alpha ]]')).toEqual({kind: 'page', name: 'Project Alpha'})
  })

  it('reads ((ref)) and ^ref as a block reference', () => {
    expect(parseAgentTarget(`(( ${ID} ))`)).toEqual({kind: 'block', ref: ID})
    expect(parseAgentTarget(`^${ID}`)).toEqual({kind: 'block', ref: ID})
  })

  it('leaves everything else bare for the resolver to try as id, page name, then date', () => {
    expect(parseAgentTarget('  today ')).toEqual({kind: 'bare', text: 'today'})
    expect(parseAgentTarget(ID)).toEqual({kind: 'bare', text: ID})
  })

  it('refuses an empty target and an empty [[ ]] / (( ))', () => {
    expect(() => parseAgentTarget('   ')).toThrow(/empty/)
    expect(() => parseAgentTarget('[[  ]]')).toThrow(/empty/)
    expect(() => parseAgentTarget('(( ))')).toThrow(/names no block/)
    expect(() => parseAgentTarget('^')).toThrow(/names no block/)
  })
})
