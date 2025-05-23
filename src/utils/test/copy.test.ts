import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serializeBlockForClipboard } from '../copy';
import { handleCopyBlock, handleCopySelectedBlocks } from '../../shortcuts/defaultShortcuts';
import type { Block } from '../../data/block';
import type { BlockData } from '../../data/block';
import type { ClipboardData } from '../../types';
import type { BlockShortcutDependencies, MultiSelectModeDependencies } from '../../shortcuts/types';
import { selectionStateProp } from '../../data/properties';
import type { Repo } from '../../data/repo'; // Import Repo

// Mock navigator.clipboard
const mockWriteText = vi.fn();
const mockWrite = vi.fn();

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: mockWriteText,
    write: mockWrite,
  },
  writable: true,
});

// Helper function to create mock BlockData objects
const mockBlockData = (data: Partial<BlockData>): BlockData => ({
  id: 'defaultId',
  content: '',
  properties: {},
  childIds: [], // childIds on BlockData might be less relevant if block.children() is the source of truth for children
  createTime: Date.now(),
  updateTime: Date.now(),
  createdByUserId: 'testUser',
  updatedByUserId: 'testUser',
  ...data,
});

// Helper to create a mock Block
// Now includes children mock and a basic repo mock on the block itself
const createMockBlock = (
  data: BlockData,
  children: Block[] = [], // Children are other mock blocks
  repoInstance?: Repo // Optional repo instance for the block
): Block => ({
  id: data.id,
  data: vi.fn().mockResolvedValue(data),
  children: vi.fn().mockResolvedValue(children), // Mock children method
  repo: repoInstance || ({ find: vi.fn() } as unknown as Repo), // Mock repo property on block
} as unknown as Block);

// Mock Repo instance for general use
const mockRepo = {
  find: vi.fn(),
  // Add other Repo methods if they become necessary
} as unknown as Repo;

describe('serializeBlockForClipboard', () => {
  beforeEach(() => {
    mockRepo.find.mockClear();
  });

  it('should correctly serialize a simple block with no children', async () => {
    const sampleData = mockBlockData({
      id: 'testBlock1',
      content: 'Hello world from testBlock1',
    });
    const mockBlock = createMockBlock(sampleData, [], mockRepo); // No children
    const expectedClipboardData: ClipboardData = {
      markdown: 'Hello world from testBlock1',
      blocks: [sampleData],
    };
    const result = await serializeBlockForClipboard(mockBlock, mockRepo);
    expect(result).toEqual(expectedClipboardData);
    expect(mockBlock.data).toHaveBeenCalledTimes(1);
    expect(mockBlock.children).toHaveBeenCalledTimes(1); // fetchAllDescendantDataRecursively calls it once for the root
  });

  it('should correctly serialize a block with properties and no children', async () => {
    const sampleDataWithProps = mockBlockData({
      id: 'testBlock2',
      content: '# A Heading Here',
      properties: {
        type: { name: 'type', type: 'string', value: 'heading' },
        customProp: { name: 'customProp', type: 'number', value: 123 },
      },
    });
    const mockBlock = createMockBlock(sampleDataWithProps, [], mockRepo); // No children
    const expectedClipboardData: ClipboardData = {
      markdown: '# A Heading Here',
      blocks: [sampleDataWithProps],
    };
    const result = await serializeBlockForClipboard(mockBlock, mockRepo);
    expect(result).toEqual(expectedClipboardData);
    expect(result.blocks[0].properties).toEqual(sampleDataWithProps.properties);
    expect(mockBlock.data).toHaveBeenCalledTimes(1);
    expect(mockBlock.children).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if block.data() returns null or undefined for the root block', async () => {
    const mockBlockNullData = { id: 'testBlock3', data: vi.fn().mockResolvedValue(null), children: vi.fn().mockResolvedValue([]) } as unknown as Block;
    await expect(serializeBlockForClipboard(mockBlockNullData, mockRepo))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock3');

    const mockBlockUndefinedData = { id: 'testBlock4', data: vi.fn().mockResolvedValue(undefined), children: vi.fn().mockResolvedValue([]) } as unknown as Block;
    await expect(serializeBlockForClipboard(mockBlockUndefinedData, mockRepo))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock4');
  });

  it('should correctly serialize a block with children (depth-first)', async () => {
    const child2Data = mockBlockData({ id: 'child2', content: 'Child 2 content' });
    const child1Data = mockBlockData({ id: 'child1', content: 'Child 1 content' });
    const parentData = mockBlockData({ id: 'parent', content: 'Parent content' });

    const mockChild2 = createMockBlock(child2Data, [], mockRepo); // No grandchildren
    const mockChild1 = createMockBlock(child1Data, [], mockRepo); // No grandchildren
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2], mockRepo);

    const expectedClipboardData: ClipboardData = {
      markdown: 'Parent content\n\nChild 1 content\n\nChild 2 content',
      blocks: [parentData, child1Data, child2Data], // Depth-first order
    };

    const result = await serializeBlockForClipboard(mockParent, mockRepo);

    expect(result).toEqual(expectedClipboardData);
    expect(mockParent.data).toHaveBeenCalledTimes(1);
    expect(mockParent.children).toHaveBeenCalledTimes(1);
    expect(mockChild1.data).toHaveBeenCalledTimes(1);
    expect(mockChild1.children).toHaveBeenCalledTimes(1);
    expect(mockChild2.data).toHaveBeenCalledTimes(1);
    expect(mockChild2.children).toHaveBeenCalledTimes(1);
  });

   it('should correctly serialize a block with nested children', async () => {
    const grandchild1Data = mockBlockData({ id: 'grandchild1', content: 'Grandchild 1 content' });
    const child2Data = mockBlockData({ id: 'child2', content: 'Child 2 content' });
    const child1Data = mockBlockData({ id: 'child1', content: 'Child 1 content' });
    const parentData = mockBlockData({ id: 'parent', content: 'Parent content' });

    const mockGrandchild1 = createMockBlock(grandchild1Data, [], mockRepo);
    const mockChild1 = createMockBlock(child1Data, [mockGrandchild1], mockRepo);
    const mockChild2 = createMockBlock(child2Data, [], mockRepo);
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2], mockRepo);
    
    const expectedClipboardData: ClipboardData = {
      markdown: 'Parent content\n\nChild 1 content\n\nGrandchild 1 content\n\nChild 2 content',
      blocks: [parentData, child1Data, grandchild1Data, child2Data],
    };

    const result = await serializeBlockForClipboard(mockParent, mockRepo);
    expect(result).toEqual(expectedClipboardData);
   });
});

describe('Clipboard Action Handlers', () => {
  beforeEach(() => {
    mockWriteText.mockClear();
    mockWrite.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRepo.find.mockClear(); // Clear repo mock for handler tests
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleCopyBlock', () => {
    it('should copy a single block (and its descendants) to clipboard', async () => {
      // Setup: Block with one child
      const childData = mockBlockData({ id: 'childForHandleCopy', content: 'Child of handleCopyBlock' });
      const parentData = mockBlockData({ id: 'parentForHandleCopy', content: 'Parent for handleCopyBlock' });
      const mockChild = createMockBlock(childData, [], mockRepo);
      const mockParentBlock = createMockBlock(parentData, [mockChild], mockRepo);

      const deps: BlockShortcutDependencies = {
        block: mockParentBlock,
        uiStateBlock: {} as Block,
        repo: mockRepo, // Pass the general mockRepo
      };

      await handleCopyBlock(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'Parent for handleCopyBlock\n\nChild of handleCopyBlock',
        blocks: [parentData, childData],
      };
      expect(mockWriteText).toHaveBeenCalledWith(JSON.stringify(expectedClipboardData));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;
      const blob = await clipboardItemArg.getType('text/plain');
      expect(await blob.text()).toBe('Parent for handleCopyBlock\n\nChild of handleCopyBlock');
    });

    it('should handle error if serializeBlockForClipboard fails in handleCopyBlock', async () => {
      // Mock block.data() to throw for the specific block used in handleCopyBlock
      const failingBlock = {
         id: 'failBlock',
         data: vi.fn().mockRejectedValue(new Error('Serialization failed directly')),
         children: vi.fn().mockResolvedValue([]) // Needs children mock too
        } as unknown as Block;
      const deps: BlockShortcutDependencies = { block: failingBlock, uiStateBlock: {} as Block, repo: mockRepo };

      await handleCopyBlock(deps);

      expect(mockWriteText).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('Failed to copy block to clipboard:', expect.any(Error));
    });
  });

  describe('handleCopySelectedBlocks', () => {
    it('should copy multiple selected blocks (each with their descendants) to clipboard', async () => {
      // Block 1 with a child
      const b1ChildData = mockBlockData({ id: 'b1Child', content: 'Block1 Child' });
      const b1Data = mockBlockData({ id: 'selBlock1', content: 'Selected Block 1' });
      const mockB1Child = createMockBlock(b1ChildData, [], mockRepo);
      const mockBlock1 = createMockBlock(b1Data, [mockB1Child], mockRepo);

      // Block 2 (no children)
      const b2Data = mockBlockData({ id: 'selBlock2', content: 'Selected Block 2 (no children)' });
      const mockBlock2 = createMockBlock(b2Data, [], mockRepo);

      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({
          value: { selectedBlockIds: ['selBlock1', 'selBlock2'], anchorBlockId: 'selBlock1' }
        }),
      } as unknown as Block;

      // Update mockRepo.find for handleCopySelectedBlocks
      const specificMockRepo = {
        find: vi.fn(id => {
          if (id === 'selBlock1') return mockBlock1;
          if (id === 'selBlock2') return mockBlock2;
          return undefined;
        }),
      } as unknown as Repo;

      const deps: MultiSelectModeDependencies = {
        uiStateBlock: mockUiStateBlock,
        repo: specificMockRepo,
      };

      await handleCopySelectedBlocks(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'Selected Block 1\n\nBlock1 Child\n\nSelected Block 2 (no children)',
        blocks: [b1Data, b1ChildData, b2Data], // All blocks, descendants follow their parent
      };
      expect(JSON.parse(mockWriteText.mock.calls[0][0])).toEqual(expectedClipboardData);


      expect(mockWrite).toHaveBeenCalledTimes(1);
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;
      const blob = await clipboardItemArg.getType('text/plain');
      expect(await blob.text()).toBe('Selected Block 1\n\nBlock1 Child\n\nSelected Block 2 (no children)');
    });
    
    it('should correctly aggregate data when a selected block has nested children', async () => {
      const grandchildData = mockBlockData({ id: 'gc1', content: 'Grandchild 1'});
      const childData = mockBlockData({ id: 'c1', content: 'Child 1'});
      const parentData = mockBlockData({ id: 'p1', content: 'Parent 1 (selected)'});

      const mockGrandchild = createMockBlock(grandchildData, [], mockRepo);
      const mockChild = createMockBlock(childData, [mockGrandchild], mockRepo);
      const mockParent = createMockBlock(parentData, [mockChild], mockRepo);

      const otherSelectedData = mockBlockData({ id: 'otherSel', content: 'Other Selected (no children)'});
      const mockOtherSelected = createMockBlock(otherSelectedData, [], mockRepo);
      
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({
          value: { selectedBlockIds: ['p1', 'otherSel'], anchorBlockId: 'p1'}
        }),
      } as unknown as Block;

      const specificMockRepoForNested = {
        find: vi.fn(id => {
          if (id === 'p1') return mockParent;
          if (id === 'otherSel') return mockOtherSelected;
          return undefined;
        }),
      } as unknown as Repo;
      
      const deps: MultiSelectModeDependencies = {
        uiStateBlock: mockUiStateBlock,
        repo: specificMockRepoForNested,
      };

      await handleCopySelectedBlocks(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedFullClipboardData: ClipboardData = {
          markdown: 'Parent 1 (selected)\n\nChild 1\n\nGrandchild 1\n\nOther Selected (no children)',
          blocks: [parentData, childData, grandchildData, otherSelectedData],
      };
      expect(JSON.parse(mockWriteText.mock.calls[0][0])).toEqual(expectedFullClipboardData);
    });


    it('should do nothing if no blocks are selected in handleCopySelectedBlocks', async () => {
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({ value: { selectedBlockIds: [] } }),
      } as unknown as Block;
      const deps: MultiSelectModeDependencies = { uiStateBlock: mockUiStateBlock, repo: mockRepo };

      await handleCopySelectedBlocks(deps);
      expect(mockWriteText).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('No blocks selected to copy.');
    });

    it('should handle errors during serialization of one block in handleCopySelectedBlocks', async () => {
      const blockDataOK = mockBlockData({ id: 'selBlockOK', content: 'OK Block' });
      const mockBlockOK = createMockBlock(blockDataOK, [], mockRepo); // No children for simplicity here
      
      const failingBlock = {
         id: 'selBlockErr',
         data: vi.fn().mockRejectedValue(new Error('Fail this one')),
         children: vi.fn().mockResolvedValue([])
      } as unknown as Block;

      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({ value: { selectedBlockIds: ['selBlockOK', 'selBlockErr'] } }),
      } as unknown as Block;
      
      const specificMockRepoForError = {
        find: vi.fn(id => {
          if (id === 'selBlockOK') return mockBlockOK;
          if (id === 'selBlockErr') return failingBlock;
          return undefined;
        }),
      } as unknown as Repo;
      const deps: MultiSelectModeDependencies = { uiStateBlock: mockUiStateBlock, repo: specificMockRepoForError };

      await handleCopySelectedBlocks(deps);
      
      expect(console.error).toHaveBeenCalledWith("Failed to serialize block selBlockErr for clipboard:", expect.any(Error));
      // Still copies the block that was successful
      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'OK Block',
        blocks: [blockDataOK],
      };
      expect(JSON.parse(mockWriteText.mock.calls[0][0])).toEqual(expectedClipboardData);
    });
  });
});
