import { describe, expect, it } from 'vitest'
import {
  ROAM_ISA_PROP,
  ROAM_PAGE_ALIAS_PROP,
  collectAliasesFromRoamSemanticRefListProperties,
  collectAliasesFromRoamSemanticRefListValue,
} from '../properties'

// Regression coverage for the `isa::` hashtag bug: Roam attribute values
// that use bare `#tag` syntax were captured as a single literal page
// alias (`#CFAR #Coaching`) instead of being split into separate page
// refs. The fix hash-rewrites the value before alias extraction.
describe('collectAliasesFromRoamSemanticRefListProperties — hashtag values', () => {
  const isaAliases = (value: unknown) =>
    collectAliasesFromRoamSemanticRefListProperties({[ROAM_ISA_PROP]: value})

  it('splits a multi-tag isa:: value into one alias per tag', () => {
    expect(isaAliases('#CFAR #Coaching')).toEqual(['CFAR', 'Coaching'])
  })

  it('handles a single-tag isa:: value', () => {
    expect(isaAliases('#CFAR')).toEqual(['CFAR'])
  })

  it('splits a long multi-tag isa:: value', () => {
    expect(isaAliases('#capitalism #critique #coordination #civilization')).toEqual(
      ['capitalism', 'critique', 'coordination', 'civilization'],
    )
  })

  // The real-world shape: `isa::` with bullet children lands as an array
  // of per-bullet strings, some bracketed, some bare hashtags.
  it('splits hashtags inside an array of isa:: values', () => {
    expect(isaAliases(['[[person]]', '#CFAR', '#Coaching'])).toEqual(
      ['person', 'CFAR', 'Coaching'],
    )
  })

  it('never emits a `#`-prefixed literal alias', () => {
    const aliases = isaAliases(['#Kotlin #Java #JVM #DSL', '#Roam #Clojure'])
    expect(aliases.some(a => a.includes('#'))).toBe(false)
    expect(aliases).toEqual(['Kotlin', 'Java', 'JVM', 'DSL', 'Roam', 'Clojure'])
  })

  it('leaves plain-text and bracketed isa:: values unchanged', () => {
    expect(isaAliases('person')).toEqual(['person'])
    expect(isaAliases('[[person]] [[friend]]')).toEqual(['person', 'friend'])
  })
})

describe('collectAliasesFromRoamSemanticRefListValue — hashtag values', () => {
  it('rewrites bare hashtags before extracting aliases (broad mode)', () => {
    expect(collectAliasesFromRoamSemanticRefListValue('#CFAR #Coaching', 'broad')).toEqual(
      ['CFAR', 'Coaching'],
    )
  })
})

describe('collectAliasesFromRoamSemanticRefListProperties — page_alias', () => {
  it('does not invent `#`-prefixed page aliases', () => {
    const aliases = collectAliasesFromRoamSemanticRefListProperties({
      [ROAM_PAGE_ALIAS_PROP]: '#CFAR',
    })
    expect(aliases.some(a => a.includes('#'))).toBe(false)
  })
})
