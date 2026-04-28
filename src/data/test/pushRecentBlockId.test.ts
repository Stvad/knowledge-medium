import { describe, it, expect, vi } from 'vitest'
import { pushRecentBlockId, recentBlockIdsProp, RECENT_BLOCKS_LIMIT } from '@/data/properties'
import type { Block } from '@/data/block'

const makeFakeBlock = (initialIds: string[] = []) => {
  let stored: string[] = [...initialIds]
  const setProperty = vi.fn((property: {value: string[]}) => {
    stored = [...(property.value as string[])]
  })
  const block = {
    dataSync: () => ({
      properties: {
        [recentBlockIdsProp.name]: {...recentBlockIdsProp, value: stored},
      },
    }),
    setProperty,
  } as unknown as Block
  return {block, setProperty, getStored: () => stored}
}

describe('pushRecentBlockId', () => {
  it('pushes a new id to the front', () => {
    const {block, setProperty, getStored} = makeFakeBlock(['old-1', 'old-2'])

    pushRecentBlockId(block, 'new')

    expect(setProperty).toHaveBeenCalledOnce()
    expect(getStored()).toEqual(['new', 'old-1', 'old-2'])
  })

  it('moves an existing id to the front (dedup)', () => {
    const {block, getStored} = makeFakeBlock(['a', 'b', 'c'])

    pushRecentBlockId(block, 'b')

    expect(getStored()).toEqual(['b', 'a', 'c'])
  })

  it('caps the list at RECENT_BLOCKS_LIMIT', () => {
    const initial = Array.from({length: RECENT_BLOCKS_LIMIT}, (_, i) => `id-${i}`)
    const {block, getStored} = makeFakeBlock(initial)

    pushRecentBlockId(block, 'fresh')

    expect(getStored()).toHaveLength(RECENT_BLOCKS_LIMIT)
    expect(getStored()[0]).toBe('fresh')
    expect(getStored()).not.toContain(`id-${RECENT_BLOCKS_LIMIT - 1}`)
  })

  it('handles empty initial state', () => {
    const {block, getStored} = makeFakeBlock([])

    pushRecentBlockId(block, 'first')

    expect(getStored()).toEqual(['first'])
  })
})
