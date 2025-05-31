import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { serializeBlock, copySelectedBlocksToClipboard, serializeSelectedBlocks } from '../copy'
import type { Block } from '../../data/block'
import type { ClipboardData, BlockData } from '../../types'
import type { Repo } from '../../data/repo'

// Mock navigator.clipboard
const mockWrite = vi.fn()

Object.defineProperty(navigator, 'clipboard', {
  value: {write: mockWrite},
  writable: true,
})

// Helper function to create mock BlockData objects
const mockBlockData = (data: Partial<BlockData>): BlockData => ({
  id: 'defaultId',
  content: '',
  properties: {},
  childIds: [],
  createTime: Date.now(),
  updateTime: Date.now(),
  createdByUserId: 'testUser',
  updatedByUserId: 'testUser',
  references: [],
  ...data,
})

// Helper to create a mock Block
const createMockBlock = (
  data: BlockData,
  children: Block[] = [],
): Block => ({
  id: data.id,
  data: vi.fn().mockResolvedValue(data),
  children: vi.fn().mockResolvedValue(children),
} as unknown as Block)

// Mock Repo instance for general use
const mockRepo = {
  find: vi.fn(),
} as unknown as Repo

describe('serializeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should correctly serialize a simple block with no children', async () => {
    const sampleData = mockBlockData({
      id: 'testBlock1',
      content: 'Hello world from testBlock1',
    })
    const mockBlock = createMockBlock(sampleData)
    const expectedClipboardData: ClipboardData = {
      markdown: '- Hello world from testBlock1',
      blocks: [sampleData],
    }
    const result = await serializeBlock(mockBlock)
    expect(result).toEqual(expectedClipboardData)
  })

  it('should correctly serialize a block with properties and no children', async () => {
    const sampleDataWithProps = mockBlockData({
      id: 'testBlock2',
      content: '# A Heading Here',
      properties: {
        type: {name: 'type', type: 'string', value: 'heading'},
        customProp: {name: 'customProp', type: 'number', value: 123},
      },
    })
    const mockBlock = createMockBlock(sampleDataWithProps)
    const expectedClipboardData: ClipboardData = {
      markdown: '- # A Heading Here',
      blocks: [sampleDataWithProps],
    }
    const result = await serializeBlock(mockBlock)
    expect(result).toEqual(expectedClipboardData)
    expect(result.blocks[0].properties).toEqual(sampleDataWithProps.properties)
  })

  it('should throw an error if block.data() returns null or undefined for the root block', async () => {
    const mockBlockNullData = {
      id: 'testBlock3',
      data: vi.fn().mockResolvedValue(null),
      children: vi.fn().mockResolvedValue([]),
    } as unknown as Block
    await expect(serializeBlock(mockBlockNullData))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock3')

    const mockBlockUndefinedData = {
      id: 'testBlock4',
      data: vi.fn().mockResolvedValue(undefined),
      children: vi.fn().mockResolvedValue([]),
    } as unknown as Block
    await expect(serializeBlock(mockBlockUndefinedData))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock4')
  })

  it('should correctly serialize a block with children, indenting children by two spaces', async () => {
    const child2Data = mockBlockData({id: 'child2', content: 'Child 2 content'})
    const child1Data = mockBlockData({id: 'child1', content: 'Child 1 content'})
    const parentData = mockBlockData({id: 'parent', content: 'Parent content'})

    const mockChild2 = createMockBlock(child2Data)
    const mockChild1 = createMockBlock(child1Data)
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2])

    const expectedClipboardData: ClipboardData = {
      markdown: `- Parent content
  - Child 1 content
  - Child 2 content`,
      blocks: [parentData, child1Data, child2Data],
    }

    const result = await serializeBlock(mockParent)
    expect(result).toEqual(expectedClipboardData)
  })

  it('should correctly serialize a block with nested children, indenting appropriately', async () => {
    const grandchild1Data = mockBlockData({id: 'grandchild1', content: 'Grandchild 1 content'})
    const child2Data = mockBlockData({id: 'child2', content: 'Child 2 content'})
    const child1Data = mockBlockData({id: 'child1', content: 'Child 1 content'})
    const parentData = mockBlockData({id: 'parent', content: 'Parent content'})

    const mockGrandchild1 = createMockBlock(grandchild1Data)
    const mockChild1 = createMockBlock(child1Data, [mockGrandchild1])
    const mockChild2 = createMockBlock(child2Data)
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2])

    const expectedClipboardData: ClipboardData = {
      markdown: `- Parent content
  - Child 1 content
    - Grandchild 1 content
  - Child 2 content`,
      blocks: [parentData, child1Data, grandchild1Data, child2Data],
    }

    const result = await serializeBlock(mockParent)
    expect(result).toEqual(expectedClipboardData)
  })

  it('should handle multiline content with proper indentation', async () => {
    const childData = mockBlockData({
      id: 'child',
      content: `Line 1
Line 2
Line 3`,
    })
    const parentData = mockBlockData({
      id: 'parent',
      content: `Parent
With
Multiple
Lines`,
    })

    const mockChild = createMockBlock(childData)
    const mockParent = createMockBlock(parentData, [mockChild])

    const expectedClipboardData: ClipboardData = {
      markdown: `- Parent
  With
  Multiple
  Lines
  - Line 1
    Line 2
    Line 3`,
      blocks: [parentData, childData],
    }

    const result = await serializeBlock(mockParent)
    expect(result).toEqual(expectedClipboardData)
  })

  it('should properly indent multiline content at each nesting level', async () => {
    const grandchildData = mockBlockData({
      id: 'grandchild',
      content: `Grandchild Line 1
Grandchild Line 2
Grandchild Line 3`,
    })
    const childData = mockBlockData({
      id: 'child',
      content: `Child Line 1
Child Line 2
Child Line 3`,
    })
    const parentData = mockBlockData({
      id: 'parent',
      content: `Parent Line 1
Parent Line 2
Parent Line 3`,
    })

    const mockGrandchild = createMockBlock(grandchildData)
    const mockChild = createMockBlock(childData, [mockGrandchild])
    const mockParent = createMockBlock(parentData, [mockChild])

    const expectedClipboardData: ClipboardData = {
      markdown: `- Parent Line 1
  Parent Line 2
  Parent Line 3
  - Child Line 1
    Child Line 2
    Child Line 3
    - Grandchild Line 1
      Grandchild Line 2
      Grandchild Line 3`,
      blocks: [parentData, childData, grandchildData],
    }

    const result = await serializeBlock(mockParent)
    expect(result).toEqual(expectedClipboardData)
  })

  it('should handle complex nested multiline content with mixed indentation', async () => {
    const level3Data = mockBlockData({
      id: 'level3',
      content: `Level 3.1
Level 3.2
  Level 3.3 (pre-indented)
Level 3.4`,
    })
    const level2Data = mockBlockData({
      id: 'level2',
      content: `Level 2.1
  Level 2.2 (pre-indented)
Level 2.3`,
    })
    const level1Data = mockBlockData({
      id: 'level1',
      content: `Level 1.1
  Level 1.2 (pre-indented)
Level 1.3`,
    })

    const mockLevel3 = createMockBlock(level3Data)
    const mockLevel2 = createMockBlock(level2Data, [mockLevel3])
    const mockLevel1 = createMockBlock(level1Data, [mockLevel2])

    const expectedClipboardData: ClipboardData = {
      markdown: `- Level 1.1
    Level 1.2 (pre-indented)
  Level 1.3
  - Level 2.1
      Level 2.2 (pre-indented)
    Level 2.3
    - Level 3.1
      Level 3.2
        Level 3.3 (pre-indented)
      Level 3.4`,
      blocks: [level1Data, level2Data, level3Data],
    }

    const result = await serializeBlock(mockLevel1)
    expect(result).toEqual(expectedClipboardData)
  })
})

describe('Clipboard Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('copySelectedBlocksToClipboard', () => {
    it('should handle empty selection gracefully', async () => {
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({
          value: {selectedBlockIds: []},
        }),
      } as unknown as Block

      await copySelectedBlocksToClipboard(mockUiStateBlock, mockRepo)
      expect(mockWrite).not.toHaveBeenCalled()
    })

    it('should handle null selection state gracefully', async () => {
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue(null),
      } as unknown as Block

      await copySelectedBlocksToClipboard(mockUiStateBlock, mockRepo)
      expect(mockWrite).not.toHaveBeenCalled()
    })
  })
})

describe('serializeSelectedBlocks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should process multiple blocks and combine their markdown and blocks', async () => {
    const block1Data = mockBlockData({id: 'block1', content: 'Block 1 content'})
    const block2Data = mockBlockData({id: 'block2', content: 'Block 2 content'})

    const mockBlock1 = createMockBlock(block1Data)
    const mockBlock2 = createMockBlock(block2Data)

    const mockRepo = {
      find: vi.fn(id => {
        if (id === 'block1') return mockBlock1
        if (id === 'block2') return mockBlock2
        return null
      }),
    } as unknown as Repo

    const result = await serializeSelectedBlocks(['block1', 'block2'], mockRepo)

    expect(result).toEqual({
      markdown: `- Block 1 content
- Block 2 content`,
      blocks: [block1Data, block2Data],
    })
    expect(mockRepo.find).toHaveBeenCalledTimes(2)
    expect(mockRepo.find).toHaveBeenCalledWith('block1')
    expect(mockRepo.find).toHaveBeenCalledWith('block2')
  })

  it('should handle nested blocks within selected blocks', async () => {
    const childData = mockBlockData({id: 'child', content: 'Child content'})
    const block1Data = mockBlockData({id: 'block1', content: 'Block 1 content'})
    const block2Data = mockBlockData({id: 'block2', content: 'Block 2 content'})
    
    const mockChild = createMockBlock(childData)
    const mockBlock1 = createMockBlock(block1Data, [mockChild])
    const mockBlock2 = createMockBlock(block2Data)

    const mockRepo = {
      find: vi.fn(id => {
        if (id === 'block1') return mockBlock1
        if (id === 'block2') return mockBlock2
        return null
      }),
    } as unknown as Repo

    const result = await serializeSelectedBlocks(['block1', 'block2'], mockRepo)

    expect(result).toEqual({
      markdown: `- Block 1 content
  - Child content
- Block 2 content`,
      blocks: [block1Data, childData, block2Data],
    })
  })

  it('should filter out non-existent blocks', async () => {
    const block1Data = mockBlockData({id: 'block1', content: 'Block 1 content'})
    const mockBlock1 = createMockBlock(block1Data)

    const mockRepo = {
      find: vi.fn(id => {
        if (id === 'block1') return mockBlock1
        return null
      }),
    } as unknown as Repo

    const result = await serializeSelectedBlocks(['block1', 'nonexistent'], mockRepo)

    expect(result).toEqual({
      markdown: `- Block 1 content`,
      blocks: [block1Data],
    })
    expect(mockRepo.find).toHaveBeenCalledTimes(2)
  })

  it('should filter out blocks that fail to serialize', async () => {
    const block1Data = mockBlockData({id: 'block1', content: 'Block 1 content'})
    const block2Data = mockBlockData({id: 'block2', content: 'Block 2 content'})
    
    const mockBlock1 = createMockBlock(block1Data)
    const mockBlock2 = {
      ...createMockBlock(block2Data),
      data: vi.fn().mockRejectedValue(new Error('Serialization failed')),
    } as unknown as Block

    const mockRepo = {
      find: vi.fn(id => {
        if (id === 'block1') return mockBlock1
        if (id === 'block2') return mockBlock2
        return null
      }),
    } as unknown as Repo

    const result = await serializeSelectedBlocks(['block1', 'block2'], mockRepo)

    expect(result).toEqual({
      markdown: `- Block 1 content`,
      blocks: [block1Data],
    })
    expect(mockRepo.find).toHaveBeenCalledTimes(2)
  })

  it('should throw an error if no blocks could be serialized', async () => {
    const block1Data = mockBlockData({id: 'block1', content: 'Block 1 content'})
    const mockBlock1 = {
      ...createMockBlock(block1Data),
      data: vi.fn().mockRejectedValue(new Error('Serialization failed')),
    } as unknown as Block

    const mockRepo = {
      find: vi.fn(() => mockBlock1),
    } as unknown as Repo

    await expect(serializeSelectedBlocks(['block1'], mockRepo))
      .rejects
      .toThrow('No block data could be serialized for copying')
  })

  it('should handle empty block IDs array', async () => {
    const mockRepo = {
      find: vi.fn(),
    } as unknown as Repo

    await expect(serializeSelectedBlocks([], mockRepo))
      .rejects
      .toThrow('No block data could be serialized for copying')
    expect(mockRepo.find).not.toHaveBeenCalled()
  })
})
