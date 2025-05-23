import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serializeBlockForClipboard } from '../copy';
import { handleCopyBlock, handleCopySelectedBlocks } from '../../shortcuts/defaultShortcuts'; // Import new handlers
import type { Block } from '../../data/block';
import type { BlockData } from '../../data/block';
import type { ClipboardData } from '../../types';
import type { BlockShortcutDependencies, MultiSelectModeDependencies } from '../../shortcuts/types';
import { selectionStateProp } from '../../data/properties';

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
  childIds: [],
  createTime: Date.now(),
  updateTime: Date.now(),
  createdByUserId: 'testUser',
  updatedByUserId: 'testUser',
  ...data,
});

// Helper to create a mock Block
const createMockBlock = (data: BlockData): Block => ({
  id: data.id,
  data: vi.fn().mockResolvedValue(data),
  // Add other Block methods if they become necessary for tests
} as unknown as Block);

describe('serializeBlockForClipboard', () => {
  it('should correctly serialize a simple block with basic content', async () => {
    const sampleData = mockBlockData({
      id: 'testBlock1',
      content: 'Hello world from testBlock1',
    });
    const mockBlock = createMockBlock(sampleData);
    const expectedClipboardData: ClipboardData = {
      markdown: 'Hello world from testBlock1',
      blocks: [sampleData],
    };
    const result = await serializeBlockForClipboard(mockBlock);
    expect(result).toEqual(expectedClipboardData);
    expect(mockBlock.data).toHaveBeenCalledTimes(1);
  });

  it('should correctly serialize a block with properties', async () => {
    const sampleDataWithProps = mockBlockData({
      id: 'testBlock2',
      content: '# A Heading Here',
      properties: {
        type: { name: 'type', type: 'string', value: 'heading' },
        customProp: { name: 'customProp', type: 'number', value: 123 },
      },
    });
    const mockBlock = createMockBlock(sampleDataWithProps);
    const expectedClipboardData: ClipboardData = {
      markdown: '# A Heading Here',
      blocks: [sampleDataWithProps],
    };
    const result = await serializeBlockForClipboard(mockBlock);
    expect(result).toEqual(expectedClipboardData);
    expect(result.blocks[0].properties).toEqual(sampleDataWithProps.properties);
    expect(mockBlock.data).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if block.data() returns null or undefined', async () => {
    const mockBlockNullData = { id: 'testBlock3', data: vi.fn().mockResolvedValue(null) } as unknown as Block;
    await expect(serializeBlockForClipboard(mockBlockNullData))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock3');

    const mockBlockUndefinedData = { id: 'testBlock4', data: vi.fn().mockResolvedValue(undefined) } as unknown as Block;
    await expect(serializeBlockForClipboard(mockBlockUndefinedData))
      .rejects
      .toThrow('Failed to retrieve data for block with id testBlock4');
  });
});

describe('Clipboard Action Handlers', () => {
  beforeEach(() => {
    mockWriteText.mockClear();
    mockWrite.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {}); // Suppress console.log
    vi.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console.error
  });

  afterEach(() => {
    vi.restoreAllMocks(); // Restore console mocks
  });

  describe('handleCopyBlock', () => {
    it('should call navigator.clipboard.writeText and write with correct data', async () => {
      const bData = mockBlockData({ id: 'cb1', content: 'Copied content' });
      const mBlock = createMockBlock(bData);
      const deps: BlockShortcutDependencies = {
        block: mBlock,
        uiStateBlock: {} as Block, // Mocked, not directly used by handleCopyBlock's core logic
        repo: {} as any, // Mocked
        // Add other deps if necessary
      };

      await handleCopyBlock(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'Copied content',
        blocks: [bData],
      };
      expect(mockWriteText).toHaveBeenCalledWith(JSON.stringify(expectedClipboardData));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith([
        expect.any(ClipboardItem), // Actual ClipboardItem
      ]);
      // More detailed check for ClipboardItem content if possible and necessary
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;
      const blob = await clipboardItemArg.getType('text/plain');
      expect(await blob.text()).toBe('Copied content');
    });

    it('should handle error if serializeBlockForClipboard fails', async () => {
      const mBlock = { id: 'errBlock', data: vi.fn().mockRejectedValue(new Error('Serialization failed')) } as unknown as Block;
      const deps: BlockShortcutDependencies = { block: mBlock, uiStateBlock: {} as Block, repo: {} as any };

      await handleCopyBlock(deps);

      expect(mockWriteText).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('Failed to copy block to clipboard:', expect.any(Error));
    });
     it('should handle navigator.clipboard.write not being available', async () => {
      const originalWrite = navigator.clipboard.write;
      // @ts-ignore
      navigator.clipboard.write = undefined; // Simulate write not being available

      const bData = mockBlockData({ id: 'cb_no_write', content: 'No write API' });
      const mBlock = createMockBlock(bData);
      const deps: BlockShortcutDependencies = { block: mBlock, uiStateBlock: {} as Block, repo: {} as any };

      await handleCopyBlock(deps);

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      expect(mockWrite).not.toHaveBeenCalled(); // mockWrite itself is vi.fn(), so this checks if the *original* was called through our mock setup
      expect(console.log).toHaveBeenCalledWith('Block content (JSON) copied to clipboard. Markdown copy skipped (navigator.clipboard.write not available).');
      
      // @ts-ignore
      navigator.clipboard.write = originalWrite; // Restore
    });
  });

  describe('handleCopySelectedBlocks', () => {
    it('should copy multiple selected blocks to clipboard', async () => {
      const blockData1 = mockBlockData({ id: 'selBlock1', content: 'First selected' });
      const blockData2 = mockBlockData({ id: 'selBlock2', content: 'Second selected' });
      const mockBlock1 = createMockBlock(blockData1);
      const mockBlock2 = createMockBlock(blockData2);

      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({
          value: {
            selectedBlockIds: ['selBlock1', 'selBlock2'],
            anchorBlockId: 'selBlock1',
          }
        }),
      } as unknown as Block;

      const mockRepo = {
        find: vi.fn(id => {
          if (id === 'selBlock1') return mockBlock1;
          if (id === 'selBlock2') return mockBlock2;
          return undefined;
        }),
      } as any;

      const deps: MultiSelectModeDependencies = {
        uiStateBlock: mockUiStateBlock,
        repo: mockRepo,
        // Add other deps if necessary
      };

      await handleCopySelectedBlocks(deps);

      expect(mockUiStateBlock.getProperty).toHaveBeenCalledWith(selectionStateProp);
      expect(mockRepo.find).toHaveBeenCalledWith('selBlock1');
      expect(mockRepo.find).toHaveBeenCalledWith('selBlock2');

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'First selected\n\nSecond selected',
        blocks: [blockData1, blockData2],
      };
      expect(mockWriteText).toHaveBeenCalledWith(JSON.stringify(expectedClipboardData));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const clipboardItemArg = mockWrite.mock.calls[0][0][0] as ClipboardItem;
      const blob = await clipboardItemArg.getType('text/plain');
      expect(await blob.text()).toBe('First selected\n\nSecond selected');
    });

    it('should do nothing if no blocks are selected', async () => {
      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({ value: { selectedBlockIds: [] } }),
      } as unknown as Block;
      const deps: MultiSelectModeDependencies = { uiStateBlock: mockUiStateBlock, repo: {} as any };

      await handleCopySelectedBlocks(deps);

      expect(mockWriteText).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('No blocks selected to copy.');
    });

    it('should handle errors during serialization of one of the blocks', async () => {
      const blockData1 = mockBlockData({ id: 'selBlockOK', content: 'OK Block' });
      const mockBlock1 = createMockBlock(blockData1);
      const mockBlockErr = { id: 'selBlockErr', data: vi.fn().mockRejectedValue(new Error("Failed to serialize this one!")) } as unknown as Block;

      const mockUiStateBlock = {
        getProperty: vi.fn().mockResolvedValue({ value: { selectedBlockIds: ['selBlockOK', 'selBlockErr'] } }),
      } as unknown as Block;
      const mockRepo = {
        find: vi.fn(id => {
          if (id === 'selBlockOK') return mockBlock1;
          if (id === 'selBlockErr') return mockBlockErr;
          return undefined;
        }),
      } as any;
      const deps: MultiSelectModeDependencies = { uiStateBlock: mockUiStateBlock, repo: mockRepo };

      await handleCopySelectedBlocks(deps);
      
      expect(console.error).toHaveBeenCalledWith("Failed to serialize block selBlockErr for clipboard:", expect.any(Error));
      // Still copies the block that was successful
      expect(mockWriteText).toHaveBeenCalledTimes(1);
      const expectedClipboardData: ClipboardData = {
        markdown: 'OK Block', // Only the successful one
        blocks: [blockData1],  // Only the successful one
      };
      expect(mockWriteText).toHaveBeenCalledWith(JSON.stringify(expectedClipboardData));
      expect(mockWrite).toHaveBeenCalledTimes(1);
    });
  });
});
