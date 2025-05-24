import { describe, it, expect } from 'vitest'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'
import { BlockData } from '@/types'

describe('markdownParser', () => {

  describe('parseMarkdownToBlocks', () => {
    // --- Start of Original General Parsing Tests (Unchanged) ---
    it('should parse a simple markdown string into blocks', () => {
      const markdown = 'First line\nSecond line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(2)
      expect(result[0].content).toBe('First line')
      expect(result[1].content).toBe('Second line')
      expect(result[0].childIds).toEqual([])
    })

    it('should handle indentation to create parent-child relationships', () => {
      const markdown = 'Parent\n  Child\n    Grandchild'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('Parent')
      // Children of non-header blocks should have cleaned content.
      expect(result[1].content).toBe('Child') 
      expect(result[2].content).toBe('Grandchild')

      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[1].id)
      expect(result[0].childIds).toContain(result[1].id)
      expect(result[1].childIds).toContain(result[2].id)
    })

    it('should handle list markers', () => {
      const markdown = `
- First item
- Second item
  - Nested item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('First item') // List items are cleaned of markers
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item') 

      // Based on current parser: unindented list items are siblings.
      // Indented list items are children of the preceding list item at a lesser indent.
      expect(result[0].parentId).toBeUndefined()
      expect(result[1].parentId).toBeUndefined() 
      expect(result[2].parentId).toBe(result[1].id) // "Nested item" is child of "Second item"
      expect(result[1].childIds).toContain(result[2].id)
      expect(result[0].childIds).toHaveLength(0)
    })

    it('should handle list markers 2', () => {
      const markdown = `
- a
    - b
    - c
        - d`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(4)
      expect(result[0].content).toBe('a')
      expect(result[1].content).toBe('b')
      expect(result[2].content).toBe('c')
      expect(result[3].content).toBe('d')

      expect(result[1].parentId).toBe(result[0].id) // b child of a
      expect(result[2].parentId).toBe(result[0].id) // c child of a
      expect(result[3].parentId).toBe(result[2].id) // d child of c
      expect(result[1].childIds).toHaveLength(0)
      expect(result[0].childIds).toContain(result[1].id)
      expect(result[0].childIds).toContain(result[2].id)
      expect(result[2].childIds).toContain(result[3].id)
    })


    it('should handle empty lines', () => {
      const markdown = 'First line\n\nSecond line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(2)
      expect(result[0].content).toBe('First line')
      expect(result[1].content).toBe('Second line')
    })

    it('should handle mixed indentation and list markers', () => {
      const markdown = `
Root
  - First item
    - Nested item
  Second item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(4)
      expect(result[0].content).toBe('Root')
      expect(result[1].content).toBe('First item') // Cleaned content
      expect(result[2].content).toBe('Nested item') // Cleaned content
      expect(result[3].content).toBe('Second item') // Cleaned content

      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[1].id) // Nested under "First item"
      expect(result[3].parentId).toBe(result[0].id) // "Second item" child of "Root"
    })

    it('should handle numbered lists', () => {
      const markdown = `1. First item
2. Second item
   1. Nested item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('First item')
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item') // Cleaned content
      expect(result[0].parentId).toBeUndefined()
      expect(result[1].parentId).toBeUndefined()
      expect(result[2].parentId).toBe(result[1].id)
    })

    it('should set default properties', () => {
      const markdown = 'Single line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(1)
      expect(result[0].childIds).toEqual([])
    })
    // --- End of Original General Parsing Tests ---

    // --- Start of 5 New/Modified Tests ---
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
        expect(blocks[0].content).toBe('# Header 1');
        expect(blocks[0].parentId).toBeUndefined();
        expect(blocks[0].childIds?.length).toBe(2); 
        expect(blocks[0].childIds).toContain(blocks[1].id); 
        expect(blocks[0].childIds).toContain(blocks[2].id); 

        expect(blocks[1].content).toBe('  Content under header 1'); 
        expect(blocks[1].parentId).toBe(blocks[0].id);
        expect(blocks[1].childIds).toEqual([]);

        expect(blocks[2].content).toBe('## Header 2');
        expect(blocks[2].parentId).toBe(blocks[0].id); 
        expect(blocks[2].childIds?.length).toBe(1);
        expect(blocks[2].childIds).toContain(blocks[3].id);

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
        expect(blocks[1].parentId).toBeUndefined();
        expect(blocks[1].childIds).toEqual([]);
    });

    it('should parse a mix of headers and regular content', () => {
        const markdown = 'Regular content line 1\n# Header 1\n  Content under H1\nRegular content line 2\n## Header 2';
        const blocks = parseMarkdownToBlocks(markdown);

        expect(blocks.length).toBe(5);
        expect(blocks[0].content).toBe('Regular content line 1');
        expect(blocks[0].parentId).toBeUndefined();
        expect(blocks[0].childIds).toEqual([]);

        expect(blocks[1].content).toBe('# Header 1');
        expect(blocks[1].parentId).toBeUndefined();
        expect(blocks[1].childIds?.length).toBe(1); 
        expect(blocks[1].childIds).toContain(blocks[2].id);
        expect(blocks[1].childIds).not.toContain(blocks[4].id);

        expect(blocks[2].content).toBe('  Content under H1'); 
        expect(blocks[2].parentId).toBe(blocks[1].id);
        expect(blocks[2].childIds).toEqual([]);

        expect(blocks[3].content).toBe('Regular content line 2');
        expect(blocks[3].parentId).toBeUndefined(); 
        expect(blocks[3].childIds).toEqual([]);

        expect(blocks[4].content).toBe('## Header 2');
        expect(blocks[4].parentId).toBeUndefined(); 
        expect(blocks[4].childIds).toEqual([]);
    });
    // --- End of 5 New/Modified Tests ---

    const findBlockByContent = (blocks: Partial<BlockData>[], content: string) => {
      return blocks.find(block => block.content === content);
    };

    describe('Markdown Header Parsing', () => { 
      it('1. Basic Header and Child', () => {
        const markdownAdjusted = `# Header 1\n  Text under header`; // Text must be indented to be child
        const resultAdjusted = parseMarkdownToBlocks(markdownAdjusted);
        const header1Adjusted = resultAdjusted.find(b => b.content === '# Header 1');
        const textUnderHeaderAdjusted = resultAdjusted.find(b => b.content === '  Text under header');

        expect(header1Adjusted).toBeDefined();
        expect(header1Adjusted?.content).toBe('# Header 1');
        expect(textUnderHeaderAdjusted).toBeDefined();
        expect(textUnderHeaderAdjusted?.parentId).toBe(header1Adjusted?.id);
        expect(header1Adjusted?.childIds).toContain(textUnderHeaderAdjusted?.id);
      });

      it('2. Multiple Headers', () => {
        const markdownAdjusted = `# Header 1\n  Text under H1\n## Header 2\n  Text under H2`;
        const result = parseMarkdownToBlocks(markdownAdjusted);

        expect(result).toHaveLength(4);
        const header1 = result.find(b => b.content === '# Header 1');
        const textUnderH1 = result.find(b => b.content === '  Text under H1');
        const header2 = result.find(b => b.content === '## Header 2');
        const textUnderH2 = result.find(b => b.content === '  Text under H2');

        expect(header1?.content).toBe('# Header 1');
        expect(header2?.content).toBe('## Header 2');

        expect(header1?.parentId).toBeUndefined();
        expect(textUnderH1?.parentId).toBe(header1?.id);
        expect(header1?.childIds).toContain(textUnderH1?.id);
        
        expect(header2?.parentId).toBe(header1?.id); // ##H2 is child of #H1
        expect(header1?.childIds).toContain(header2?.id);

        expect(textUnderH2?.parentId).toBe(header2?.id);
        expect(header2?.childIds).toContain(textUnderH2?.id);
      });

      it('3. Header with Indented List Item', () => {
        const markdown = `# Header\n  - List item`; 
        const result = parseMarkdownToBlocks(markdown);

        expect(result).toHaveLength(2);
        const header = result.find(b => b.content === '# Header');
        const listItem = result.find(b => b.content === '  - List item'); 

        expect(header?.content).toBe('# Header');
        expect(listItem).toBeDefined();

        expect(header?.parentId).toBeUndefined();
        expect(listItem?.parentId).toBe(header?.id);
        expect(header?.childIds).toContain(listItem?.id);
        expect(listItem?.content).toBe('  - List item'); 
      });

      it('4. Header with Multiple Children (Indented)', () => {
        const markdown = `# Header\n  Line 1\n  Line 2\n    - List item\n  Another line`;
        const result = parseMarkdownToBlocks(markdown);

        expect(result).toHaveLength(5);
        const header = result.find(b => b.content === '# Header');
        const line1 = result.find(b => b.content === '  Line 1'); // First child of header, original content
        const line2 = result.find(b => b.content === 'Line 2'); // Second child of header, cleaned content due to context neutralization
        const listItem = result.find(b => b.content === 'List item');  // Child of non-header line2, cleaned
        const anotherLine = result.find(b => b.content === 'Another line'); // Third child of header, cleaned content

        expect(header?.content).toBe('# Header');
        
        expect(header?.parentId).toBeUndefined();
        expect(line1?.parentId).toBe(header?.id);
        expect(line2?.parentId).toBe(header?.id);
        expect(listItem?.parentId).toBe(line2?.id); 
        expect(anotherLine?.parentId).toBe(header?.id);

        expect(header?.childIds).toContain(line1?.id);
        expect(header?.childIds).toContain(line2?.id);
        expect(line2?.childIds).toContain(listItem?.id);
        expect(header?.childIds).toContain(anotherLine?.id);
        expect(listItem?.content).toBe('List item'); // Expect cleaned content
      });

      it('5. Deeper Level Header (e.g., ###) and Child (Indented)', () => {
        const markdown = `### Deep Header\n  Text under deep header`; 
        const result = parseMarkdownToBlocks(markdown);

        expect(result).toHaveLength(2);
        const deepHeader = result.find(b => b.content === '### Deep Header');
        const textUnderDeepHeader = result.find(b => b.content === '  Text under deep header');
        
        expect(deepHeader?.content).toBe('### Deep Header'); 
        expect(textUnderDeepHeader).toBeDefined();

        expect(deepHeader?.parentId).toBeUndefined();
        expect(textUnderDeepHeader?.parentId).toBe(deepHeader?.id);
        expect(deepHeader?.childIds).toContain(textUnderDeepHeader?.id);
      });

      it('6. Mixed Content with Headers (aligning with current parser)', () => {
        const markdown = `Plain text line 1\n# Header 1\n  Text under H1\n\nPlain text line 2\n## Header 2\n  Text under H2\n    Sub-item 1\n    Sub-item 2`;
        const result = parseMarkdownToBlocks(markdown);

        expect(result).toHaveLength(8);
        const plainText1 = result.find(b => b.content === 'Plain text line 1');
        const header1 = result.find(b => b.content === '# Header 1');
        const textUnderH1 = result.find(b => b.content === '  Text under H1'); // Child of header, original
        const plainText2 = result.find(b => b.content === 'Plain text line 2'); 
        const header2 = result.find(b => b.content === '## Header 2');
        const textUnderH2 = result.find(b => b.content === '  Text under H2'); // Child of header, original
        const subItem1 = result.find(b => b.content === 'Sub-item 1'); // Child of non-header, cleaned
        const subItem2 = result.find(b => b.content === 'Sub-item 2'); // Child of non-header, cleaned
        
        expect(header1?.content).toBe('# Header 1');
        expect(header2?.content).toBe('## Header 2');
        
        expect(plainText1?.parentId).toBeUndefined();
        expect(header1?.parentId).toBeUndefined();
        expect(textUnderH1?.parentId).toBe(header1?.id);
        expect(header1?.childIds).toContain(textUnderH1?.id);

        expect(plainText2?.parentId).toBeUndefined(); 

        expect(header2?.parentId).toBeUndefined(); // After empty line, ##H2 starts new L0 context
        expect(textUnderH2?.parentId).toBe(header2?.id);
        expect(subItem1?.parentId).toBe(textUnderH2?.id);                                                     
        expect(subItem2?.parentId).toBe(textUnderH2?.id);
        expect(header2?.childIds).toContain(textUnderH2?.id);
        expect(textUnderH2?.childIds).toContain(subItem1?.id);
        expect(textUnderH2?.childIds).toContain(subItem2?.id);
        expect(subItem1?.content).toBe('Sub-item 1'); // Expect cleaned content
        expect(subItem2?.content).toBe('Sub-item 2'); // Expect cleaned content
      });

      it('7. Header at the End of Input', () => {
        const markdown = `Some text\n# Final Header`;
        const result = parseMarkdownToBlocks(markdown);
        
        const finalHeader = result.find(b => b.content === '# Final Header');
        expect(finalHeader?.content).toBe('# Final Header');
        expect(finalHeader?.parentId).toBeUndefined(); 
        expect(finalHeader?.childIds).toEqual([]);
      });

      it('8. Input with Only Headers (aligning with new hierarchical parsing)', () => {
        const markdown = `# Header 1\n## Header 2\n### Header 3`;
        const result = parseMarkdownToBlocks(markdown);

        const header1 = result.find(b => b.content === '# Header 1');
        const header2 = result.find(b => b.content === '## Header 2');
        const header3 = result.find(b => b.content === '### Header 3');

        expect(header1?.content).toBe('# Header 1');
        expect(header2?.content).toBe('## Header 2');
        expect(header3?.content).toBe('### Header 3');

        expect(header1?.parentId).toBeUndefined();
        expect(header2?.parentId).toBe(header1?.id); 
        expect(header3?.parentId).toBe(header2?.id); 

        expect(header1?.childIds).toContain(header2?.id);
        expect(header2?.childIds).toContain(header3?.id);
        expect(header3?.childIds).toEqual([]);
      });
    })
  })
})
