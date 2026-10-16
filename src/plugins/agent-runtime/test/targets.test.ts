import { describe, expect, it } from 'vitest'
import { parseAgentTarget } from '../targets'

describe('parseAgentTarget', () => {
  it('reads [[Name]] as a page name, trimmed', () => {
    expect(parseAgentTarget('[[ Project Alpha ]]')).toEqual({kind: 'page', name: 'Project Alpha'})
  })

  it('reads ((ref)) as a block reference', () => {
    expect(parseAgentTarget('(( 3f2a9c1b ))')).toEqual({kind: 'block', ref: '3f2a9c1b'})
  })

  it('leaves everything else bare for the resolver to try as id, id prefix, then date', () => {
    expect(parseAgentTarget('  today ')).toEqual({kind: 'bare', text: 'today'})
    expect(parseAgentTarget('3f2a9c1b')).toEqual({kind: 'bare', text: '3f2a9c1b'})
  })

  it('refuses an empty target and an empty [[ ]] / (( ))', () => {
    expect(() => parseAgentTarget('   ')).toThrow(/empty/)
    expect(() => parseAgentTarget('[[  ]]')).toThrow(/empty/)
    expect(() => parseAgentTarget('(( ))')).toThrow(/empty/)
  })
})
