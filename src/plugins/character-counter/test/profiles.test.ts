import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  characterCountProfilesFacet,
  type CharacterCountProfile,
} from '../profiles'

const useOneCount = (): number => 1
const useTwoCount = (): number => 2

describe('characterCountProfilesFacet', () => {
  it('collects count profiles by id', () => {
    const profile: CharacterCountProfile = {
      id: 'custom',
      useCount: useOneCount,
    }
    const runtime = resolveFacetRuntimeSync(
      characterCountProfilesFacet.of(profile, {source: 'test'}),
    )

    expect(runtime.read(characterCountProfilesFacet).get('custom')).toBe(profile)
  })

  it('uses last-wins semantics for duplicate ids', () => {
    const first: CharacterCountProfile = {
      id: 'custom',
      useCount: useOneCount,
    }
    const second: CharacterCountProfile = {
      id: 'custom',
      useCount: useTwoCount,
    }
    const runtime = resolveFacetRuntimeSync([
      characterCountProfilesFacet.of(first, {source: 'test'}),
      characterCountProfilesFacet.of(second, {source: 'test'}),
    ])

    expect(runtime.read(characterCountProfilesFacet).get('custom')).toBe(second)
  })
})
