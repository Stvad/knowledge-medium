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

  it('should correctly serialize a simple block with no children and no leading indentation', async () => {
    const sampleData = mockBlockData({
      id: 'testBlock1',
      content: 'Hello world from testBlock1',
    });
    const mockBlock = createMockBlock(sampleData, [], mockRepo); // No children
    const expectedClipboardData: ClipboardData = {
      markdown: 'Hello world from testBlock1', // No leading spaces
      blocks: [sampleData],
    };
    const result = await serializeBlockForClipboard(mockBlock, mockRepo);
    expect(result).toEqual(expectedClipboardData);
    expect(mockBlock.data).toHaveBeenCalledTimes(1);
    expect(mockBlock.children).toHaveBeenCalledTimes(1);
  });

  it('should correctly serialize a block with properties and no children, no leading indentation', async () => {
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
      markdown: '# A Heading Here', // No leading spaces
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

  it('should correctly serialize a block with children, indenting children by two spaces', async () => {
    const child2Data = mockBlockData({ id: 'child2', content: 'Child 2 content' });
    const child1Data = mockBlockData({ id: 'child1', content: 'Child 1 content' });
    const parentData = mockBlockData({ id: 'parent', content: 'Parent content' });

    const mockChild2 = createMockBlock(child2Data, [], mockRepo);
    const mockChild1 = createMockBlock(child1Data, [], mockRepo);
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2], mockRepo);

    const expectedClipboardData: ClipboardData = {
      markdown: 'Parent content\n  Child 1 content\n  Child 2 content', // Updated indentation
      blocks: [parentData, child1Data, child2Data],
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

   it('should correctly serialize a block with nested children, indenting appropriately', async () => {
    const grandchild1Data = mockBlockData({ id: 'grandchild1', content: 'Grandchild 1 content' });
    const child2Data = mockBlockData({ id: 'child2', content: 'Child 2 content' }); // Sibling of child1
    const child1Data = mockBlockData({ id: 'child1', content: 'Child 1 content' }); // Parent of grandchild1
    const parentData = mockBlockData({ id: 'parent', content: 'Parent content' });

    const mockGrandchild1 = createMockBlock(grandchild1Data, [], mockRepo);
    const mockChild1 = createMockBlock(child1Data, [mockGrandchild1], mockRepo);
    const mockChild2 = createMockBlock(child2Data, [], mockRepo);
    const mockParent = createMockBlock(parentData, [mockChild1, mockChild2], mockRepo);
    
    const expectedClipboardData: ClipboardData = {
      markdown: 'Parent content\n  Child 1 content\n    Grandchild 1 content\n  Child 2 content', // Updated indentation
      blocks: [parentData, child1Data, grandchild1Data, child2Data],
    };

    const result = await serializeBlockForClipboard(mockParent, mockRepo);
    expect(result).toEqual(expectedClipboardData);
   });
});

describe('Clipboard Action Handlers', () => {
  beforeEach(() => {
    mockWriteText.mockClear(); // Cleared for ClipboardItem tests
    mockWrite.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRepo.find.mockClear(); 
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleCopyBlock', () => {
    it('should copy a single block (and its descendants with correct indentation) to clipboard', async () => {
      const childData = mockBlockData({ id: 'childForHandleCopy', content: 'Child of handleCopyBlock' });
      const parentData = mockBlockData({ id: 'parentForHandleCopy', content: 'Parent for handleCopyBlock' });
      const mockChild = createMockBlock(childData, [], mockRepo);
      const mockParentBlock = createMockBlock(parentData, [mockChild], mockRepo);

      const deps: BlockShortcutDependencies = {
        block: mockParentBlock,
        uiStateBlock: {} as Block,
        repo: mockRepo, 
      };

      await handleCopyBlock(deps);
      
      // Assertions for navigator.clipboard.write with ClipboardItem
      expect(mockWrite).toHaveBeenCalledTimes(1);
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;
      
      // Check text/plain part
      const plainTextBlob = await clipboardItemArg.getType('text/plain');
      expect(await plainTextBlob.text()).toBe('Parent for handleCopyBlock\n  Child of handleCopyBlock'); // Indented

      // Check application/json part
      const jsonBlob = await clipboardItemArg.getType('application/json');
      const jsonData = JSON.parse(await jsonBlob.text()) as ClipboardData;
      expect(jsonData.markdown).toBe('Parent for handleCopyBlock\n  Child of handleCopyBlock'); // Indented
      expect(jsonData.blocks).toEqual([parentData, childData]);
    });

    // This test no longer uses mockWriteText directly for the main flow
    // it('should handle error if serializeBlockForClipboard fails in handleCopyBlock', async () => { ... });
    // The fallback to writeText is tested by simulating navigator.clipboard.write as undefined
    
     it('should use writeText as fallback if navigator.clipboard.write is not available', async () => {
      const originalWrite = navigator.clipboard.write;
      // @ts-ignore
      navigator.clipboard.write = undefined; 

      const childData = mockBlockData({ id: 'childFallback', content: 'Child Content Fallback' });
      const parentData = mockBlockData({ id: 'parentFallback', content: 'Parent Content Fallback' });
      const mockChild = createMockBlock(childData, [], mockRepo);
      const mockParentBlock = createMockBlock(parentData, [mockChild], mockRepo);
      
      const deps: BlockShortcutDependencies = { block: mockParentBlock, uiStateBlock: {} as Block, repo: mockRepo };

      await handleCopyBlock(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1); // writeText is the fallback
      const writtenJson = JSON.parse(mockWriteText.mock.calls[0][0]);
      expect(writtenJson.markdown).toBe('Parent Content Fallback\n  Child Content Fallback'); // Indented
      expect(writtenJson.blocks).toEqual([parentData, childData]);
      expect(console.log).toHaveBeenCalledWith('Block content (JSON) copied to clipboard as text. Rich copy skipped (navigator.clipboard.write not available).');
      
      // @ts-ignore
      navigator.clipboard.write = originalWrite; 
    });
  });

  describe('handleCopySelectedBlocks', () => {
    it('should copy multiple selected blocks (each with their descendants and correct indentation) to clipboard', async () => {
      const b1GrandchildData = mockBlockData({ id: 'b1Grandchild', content: 'Block1 Grandchild'});
      const b1ChildData = mockBlockData({ id: 'b1Child', content: 'Block1 Child' });
      const b1Data = mockBlockData({ id: 'selBlock1', content: 'Selected Block 1' });
      
      const mockB1Grandchild = createMockBlock(b1GrandchildData, [], mockRepo);
      const mockB1Child = createMockBlock(b1ChildData, [mockB1Grandchild], mockRepo);
      const mockBlock1 = createMockBlock(b1Data, [mockB1Child], mockRepo);

      const b2Data = mockBlockData({ id: 'selBlock2', content: 'Selected Block 2 (no children)' });
      const mockBlock2 = createMockBlock(b2Data, [], mockRepo);

      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({
          value: { selectedBlockIds: ['selBlock1', 'selBlock2'], anchorBlockId: 'selBlock1' }
        }),
      } as unknown as Block;

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

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;

      const expectedMarkdown = 
`Selected Block 1
  Block1 Child
    Block1 Grandchild

Selected Block 2 (no children)`; // Note: \n\n between top-level selected blocks' markdown outputs

      const plainTextBlob = await clipboardItemArg.getType('text/plain');
      expect(await plainTextBlob.text()).toBe(expectedMarkdown);

      const jsonBlob = await clipboardItemArg.getType('application/json');
      const jsonData = JSON.parse(await jsonBlob.text()) as ClipboardData;
      expect(jsonData.markdown).toBe(expectedMarkdown);
      expect(jsonData.blocks).toEqual([b1Data, b1ChildData, b1GrandchildData, b2Data]);
    });
    
    // Fallback test for handleCopySelectedBlocks
    it('should use writeText as fallback if navigator.clipboard.write is not available for multi-select', async () => {
      const originalWrite = navigator.clipboard.write;
      // @ts-ignore
      navigator.clipboard.write = undefined;

      const b1Data = mockBlockData({ id: 'selFallback1', content: 'Selected Fallback 1' });
      const mockBlock1 = createMockBlock(b1Data, [], mockRepo);
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({ value: { selectedBlockIds: ['selFallback1'] } }),
      } as unknown as Block;
      const specificMockRepo = { find: vi.fn(() => mockBlock1) } as unknown as Repo;
      const deps: MultiSelectModeDependencies = { uiStateBlock: mockUiStateBlock, repo: specificMockRepo };

      await handleCopySelectedBlocks(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const writtenJson = JSON.parse(mockWriteText.mock.calls[0][0]);
      expect(writtenJson.markdown).toBe('Selected Fallback 1'); // No children, no extra indentation
      expect(writtenJson.blocks).toEqual([b1Data]);
      expect(console.log).toHaveBeenCalledWith('Selected blocks (JSON) copied to clipboard as text. Rich copy skipped (navigator.clipboard.write not available).');

      // @ts-ignore
      navigator.clipboard.write = originalWrite;
    });
  });
});
