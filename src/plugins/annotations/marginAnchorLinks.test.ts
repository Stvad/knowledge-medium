import {expect, it} from 'vitest'
import {anchorLinkGroups} from './marginAnchorLinks.tsx'

it('joins a block’s displaced cards on one rail and leaves a descendant stub on its own', () => {
  const groups = anchorLinkGroups([
    {key: 'first', row: 2, anchor: 20, trailing: false},
    {key: 'selected', row: 2, anchor: 33, trailing: false},
    {key: 'stub', row: 2, anchor: 20, trailing: true},
    {key: 'later', row: 4, anchor: 70, trailing: false},
  ], [20, 92, 180, 235], 'selected')

  expect(groups.map(group => group.cardYs.length)).toEqual([2, 1, 1])
  const [block, stub, laterBlock] = groups
  expect(block.sourceY).toBe(block.cardYs[0])
  expect(block.cardYs[1] - block.sourceY).toBe(72)
  expect(block.selected).toEqual({sourceY: block.sourceY + 13, cardY: block.cardYs[1]})
  expect(stub.sourceY).toBe(block.sourceY)
  expect(laterBlock.cardYs[0] - laterBlock.sourceY).toBe(165)
})
