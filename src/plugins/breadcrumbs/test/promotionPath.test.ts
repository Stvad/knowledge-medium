import { describe, expect, it } from 'vitest'
import { promotedRevealPathIds } from '@/plugins/breadcrumbs/promotionPath.js'

const parents = [
  {id: 'root'},
  {id: 'parent-a'},
  {id: 'parent-b'},
]

describe('promotedRevealPathIds', () => {
  it('returns the promoted ancestor through the original root parent', () => {
    expect(promotedRevealPathIds(parents, 'parent-a', 'source')).toEqual([
      'parent-a',
      'parent-b',
    ])
  })

  it('returns no overrides before promotion or for an unknown shown block', () => {
    expect(promotedRevealPathIds(parents, 'source', 'source')).toEqual([])
    expect(promotedRevealPathIds(parents, 'unknown', 'source')).toEqual([])
  })
})
