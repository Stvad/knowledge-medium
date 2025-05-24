import { parseMarkdownToBlocks } from '../markdownParser';
import { BlockData } from '@/types';

describe('parseMarkdownToBlocks', () => {
  it('should parse a single header, preserving the # character', () => {
    const markdown = '# Header 1';
    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks.length).toBe(1);
    expect(blocks[0].content).toBe('# Header 1');
    expect(blocks[0].parentId).toBeUndefined();
    expect(blocks[0].childIds).toEqual([]);
  });

  it('should parse multiple headers with different levels, preserving # characters', () => {
    const markdown = '# Header 1\n## Header 2';
    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks.length).toBe(2);
    expect(blocks[0].content).toBe('# Header 1');
    expect(blocks[0].parentId).toBeUndefined();
    expect(blocks[0].childIds?.length).toBe(1);
    expect(blocks[0].childIds).toContain(blocks[1].id);

    expect(blocks[1].content).toBe('## Header 2');
    expect(blocks[1].parentId).toBe(blocks[0].id);
    expect(blocks[1].childIds).toEqual([]);
  });

  it('should parse headers with content underneath, preserving # and indentation', () => {
    const markdown = '# Header 1\n  Content under header 1\n## Header 2\n  Content under header 2';
    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks.length).toBe(4);

    // Header 1
    expect(blocks[0].content).toBe('# Header 1');
    expect(blocks[0].parentId).toBeUndefined();
    expect(blocks[0].childIds?.length).toBe(2); // Header 2 and its own content line
    expect(blocks[0].childIds).toContain(blocks[1].id); // Content under header 1
    expect(blocks[0].childIds).toContain(blocks[2].id); // Header 2

    // Content under Header 1
    expect(blocks[1].content).toBe('  Content under header 1');
    expect(blocks[1].parentId).toBe(blocks[0].id);
    expect(blocks[1].childIds).toEqual([]);

    // Header 2
    expect(blocks[2].content).toBe('## Header 2');
    expect(blocks[2].parentId).toBe(blocks[0].id); // Header 2 is a child of Header 1 because of markdown structure interpretation
    expect(blocks[2].childIds?.length).toBe(1);
    expect(blocks[2].childIds).toContain(blocks[3].id);

    // Content under Header 2
    expect(blocks[3].content).toBe('  Content under header 2');
    expect(blocks[3].parentId).toBe(blocks[2].id);
    expect(blocks[3].childIds).toEqual([]);
  });

  it('should parse content with no headers', () => {
    const markdown = 'Just a line of text.\nAnother line of text.';
    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks.length).toBe(2);

    expect(blocks[0].content).toBe('Just a line of text.');
    expect(blocks[0].parentId).toBeUndefined();
    expect(blocks[0].childIds).toEqual([]);

    expect(blocks[1].content).toBe('Another line of text.');
    expect(blocks[1].parentId).toBeUndefined(); // sibling of the first line
    expect(blocks[1].childIds).toEqual([]);
  });

  it('should parse a mix of headers and regular content', () => {
    const markdown = 'Regular content line 1\n# Header 1\n  Content under H1\nRegular content line 2\n## Header 2';
    const blocks = parseMarkdownToBlocks(markdown);

    expect(blocks.length).toBe(5);

    // blocks[0]: Regular content line 1
    expect(blocks[0].content).toBe('Regular content line 1');
    expect(blocks[0].parentId).toBeUndefined();
    expect(blocks[0].childIds).toEqual([]);

    // blocks[1]: # Header 1
    expect(blocks[1].content).toBe('# Header 1');
    expect(blocks[1].parentId).toBeUndefined();
    expect(blocks[1].childIds?.length).toBe(1); // Only "Content under H1"
    expect(blocks[1].childIds).toContain(blocks[2].id);
    expect(blocks[1].childIds).not.toContain(blocks[4].id);


    // blocks[2]: Content under H1
    expect(blocks[2].content).toBe('  Content under H1');
    expect(blocks[2].parentId).toBe(blocks[1].id);
    expect(blocks[2].childIds).toEqual([]);

    // blocks[3]: Regular content line 2
    expect(blocks[3].content).toBe('Regular content line 2');
    expect(blocks[3].parentId).toBeUndefined(); // Sibling to # Header 1
    expect(blocks[3].childIds).toEqual([]);

    // blocks[4]: ## Header 2
    expect(blocks[4].content).toBe('## Header 2');
    expect(blocks[4].parentId).toBeUndefined(); // Now a sibling to # Header 1 and Regular content line 2
    expect(blocks[4].childIds).toEqual([]);
  });
});
