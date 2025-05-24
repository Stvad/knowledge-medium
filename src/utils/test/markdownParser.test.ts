import { describe, it, expect } from 'vitest'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'
// import { BlockData } from '@/types'; // Not strictly needed here due to type inference and helpers being typed.
import { findBlock, assertBlockProperties, assertParentChild } from './markdownParser.test.helpers';

describe('markdownParser', () => {

  describe('parseMarkdownToBlocks', () => {
    it('should parse a simple markdown string into blocks', () => {
      const markdown = `
First line
Second line`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(2)
      assertBlockProperties(result[0], { content: 'First line', isRoot: true, hasNoChildIds: true });
      assertBlockProperties(result[1], { content: 'Second line', isRoot: true, hasNoChildIds: true });
    })

    it('should handle indentation to create parent-child relationships', () => {
      const markdown = `
Parent
  Child
    Grandchild`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      const parentBlock = result[0];
      const childBlock = result[1];
      const grandchildBlock = result[2];

      assertBlockProperties(parentBlock, { content: 'Parent', isRoot: true, numChildren: 1, hasChildIds: [childBlock.id!] });
      assertBlockProperties(childBlock, { content: 'Child', parentId: parentBlock.id, numChildren: 1, hasChildIds: [grandchildBlock.id!] });
      assertBlockProperties(grandchildBlock, { content: 'Grandchild', parentId: childBlock.id, hasNoChildIds: true });
      
      assertParentChild(result, { content: 'Parent' }, { content: 'Child' });
      assertParentChild(result, { content: 'Child' }, { content: 'Grandchild' });
    })

    it('should handle list markers', () => {
      const markdown = `
- First item
- Second item
  - Nested item`
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(3)

      const item1 = result[0];
      const item2 = result[1];
      const nestedItem = result[2];

      assertBlockProperties(item1, { content: 'First item', isRoot: true, numChildren: 0 });
      assertBlockProperties(item2, { content: 'Second item', isRoot: true, numChildren: 1, hasChildIds: [nestedItem.id!] });
      assertBlockProperties(nestedItem, { content: 'Nested item', parentId: item2.id, numChildren: 0 });
      
      assertParentChild(result, { content: 'Second item' }, { content: 'Nested item' });
    })

    it('should handle list markers 2', () => {
      const markdown = `
- a
    - b
    - c
        - d`
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(4)

      const a = result[0];
      const b = result[1];
      const c = result[2];
      const d = result[3];

      assertBlockProperties(a, { content: 'a', isRoot: true, numChildren: 2, hasChildIds: [b.id!, c.id!] });
      assertBlockProperties(b, { content: 'b', parentId: a.id, numChildren: 0 });
      assertBlockProperties(c, { content: 'c', parentId: a.id, numChildren: 1, hasChildIds: [d.id!] });
      assertBlockProperties(d, { content: 'd', parentId: c.id, numChildren: 0 });

      assertParentChild(result, { content: 'a' }, { content: 'b' });
      assertParentChild(result, { content: 'a' }, { content: 'c' });
      assertParentChild(result, { content: 'c' }, { content: 'd' });
    })

    it('should handle empty lines', () => {
      const markdown = `
First line

Second line`
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(2)
      assertBlockProperties(result[0], { content: 'First line', isRoot: true, hasNoChildIds: true });
      assertBlockProperties(result[1], { content: 'Second line', isRoot: true, hasNoChildIds: true });
    })

    it('should handle mixed indentation and list markers', () => {
      const markdown = `
Root
  - First item
    - Nested item
  Second item`
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(4)

      const root = result[0];
      const item1 = result[1];
      const nestedItem = result[2];
      const item2 = result[3];

      assertBlockProperties(root, { content: 'Root', isRoot: true, numChildren: 2, hasChildIds: [item1.id!, item2.id!] });
      assertBlockProperties(item1, { content: 'First item', parentId: root.id, numChildren: 1, hasChildIds: [nestedItem.id!] });
      assertBlockProperties(nestedItem, { content: 'Nested item', parentId: item1.id, numChildren: 0 });
      assertBlockProperties(item2, { content: 'Second item', parentId: root.id, numChildren: 0 });

      assertParentChild(result, { content: 'Root' }, { content: 'First item' });
      assertParentChild(result, { content: 'First item' }, { content: 'Nested item' });
      assertParentChild(result, { content: 'Root' }, { content: 'Second item' });
    })

    it('should handle numbered lists, keep the number indicators', () => {
      const markdown = `
1. First item
2. Second item
   1. Nested item`
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(3)
      
      const item1 = result[0];
      const item2 = result[1];
      const nestedItem = result[2];

      assertBlockProperties(item1, { content: '1. First item', isRoot: true, numChildren: 0 });
      assertBlockProperties(item2, { content: '2. Second item', isRoot: true, numChildren: 1, hasChildIds: [nestedItem.id!] });
      assertBlockProperties(nestedItem, { content: '1. Nested item', parentId: item2.id, numChildren: 0 });
      
      assertParentChild(result, { content: '2. Second item' }, { content: '1. Nested item' });
    })

    it('should set default properties', () => {
      const markdown = 'Single line'
      const result = parseMarkdownToBlocks(markdown)
      expect(result).toHaveLength(1)
      assertBlockProperties(result[0], { content: 'Single line', isRoot: true, hasNoChildIds: true });
    })

    // --- Start of 5 New/Modified Tests ---
    it('should parse a single header, preserving the # character', () => {
        const markdown = '# Header 1';
        const blocks = parseMarkdownToBlocks(markdown);
        expect(blocks.length).toBe(1);
        assertBlockProperties(blocks[0], { content: '# Header 1', isRoot: true, hasNoChildIds: true });
    });

    it('should parse multiple headers with different levels, preserving # characters', () => {
        const markdown = `
# Header 1
## Header 2`;
        const blocks = parseMarkdownToBlocks(markdown);
        expect(blocks.length).toBe(2);
        
        const h1 = blocks[0];
        const h2 = blocks[1];

        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 1, hasChildIds: [h2.id!] });
        assertBlockProperties(h2, { content: '## Header 2', parentId: h1.id, hasNoChildIds: true });
        assertParentChild(blocks, { content: '# Header 1' }, { content: '## Header 2' });
    });

    it('should parse headers with content underneath, preserving #', () => {
        const markdown = `
# Header 1
  Content under header 1
## Header 2
  Content under header 2`;
        const blocks = parseMarkdownToBlocks(markdown);
        expect(blocks.length).toBe(4);

        const h1 = blocks[0];
        const contentH1 = blocks[1];
        const h2 = blocks[2];
        const contentH2 = blocks[3];

        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 2, hasChildIds: [contentH1.id!, h2.id!] });
        assertBlockProperties(contentH1, { content: 'Content under header 1', parentId: h1.id, hasNoChildIds: true });
        assertBlockProperties(h2, { content: '## Header 2', parentId: h1.id, numChildren: 1, hasChildIds: [contentH2.id!] });
        assertBlockProperties(contentH2, { content: 'Content under header 2', parentId: h2.id, hasNoChildIds: true });

        assertParentChild(blocks, { content: '# Header 1' }, { content: 'Content under header 1' });
        assertParentChild(blocks, { content: '# Header 1' }, { content: '## Header 2' });
        assertParentChild(blocks, { content: '## Header 2' }, { content: 'Content under header 2' });
    });

    it('should parse a mix of headers and regular content', () => {
        const markdown = `
Regular content line 1
# Header 1
- Content under H1
  - gc1 
- Regular content line 2
## Header 2
- rc3`;
        const blocks = parseMarkdownToBlocks(markdown);
        expect(blocks.length).toBe(7);

        const reg1 = blocks[0];
        const h1 = blocks[1];
        const contentH1 = blocks[2];
        const gc1 = blocks[3];
        const reg2 = blocks[4];
        const h2 = blocks[5];
        const rc3 = blocks[6];

        assertBlockProperties(reg1, { content: 'Regular content line 1', isRoot: true, hasNoChildIds: true });
        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 1, hasChildIds: [contentH1.id!, reg2.id!, h2.id!] });
        assertBlockProperties(contentH1, { content: 'Content under H1', parentId: h1.id, hasChildIds: [gc1.id!] });
        assertBlockProperties(gc1, { content: 'gc1', parentId: contentH1.id, hasNoChildIds: true });
        assertBlockProperties(reg2, { content: 'Regular content line 2', parentId: h1.id, hasNoChildIds: true });
        assertBlockProperties(h2, { content: '## Header 2', parentId: h1.id, hasChildIds: [rc3.id!] });
        assertBlockProperties(rc3, { content: 'rc3', parentId: h2.id, hasNoChildIds: true });

        assertParentChild(blocks, { content: '# Header 1' }, { content: 'Content under H1' });
    });
    
    describe('Markdown Header Parsing', () => {
      it('1. Basic Header and Child', () => {
        const markdownAdjusted = `
# Header 1
  Text under header`;
        const result = parseMarkdownToBlocks(markdownAdjusted);
        expect(result).toHaveLength(2);

        const header = findBlock(result, '# Header 1'); // findBlock throws if not found (default)
        const text = findBlock(result, 'Text under header');
        
        assertBlockProperties(header, { content: '# Header 1', isRoot: true, numChildren: 1, hasChildIds: [text!.id!] });
        assertBlockProperties(text, { content: 'Text under header', parentId: header!.id, hasNoChildIds: true });
        assertParentChild(result, '# Header 1', 'Text under header');
      });

      it('2. Multiple Headers', () => {
        const markdownAdjusted = `
# Header 1
  Text under H1
## Header 2
  Text under H2`;
        const result = parseMarkdownToBlocks(markdownAdjusted);
        expect(result).toHaveLength(4);

        const h1 = findBlock(result, '# Header 1');
        const textH1 = findBlock(result, 'Text under H1');
        const h2 = findBlock(result, '## Header 2');
        const textH2 = findBlock(result, 'Text under H2');

        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 2, hasChildIds: [textH1!.id!, h2!.id!] });
        assertBlockProperties(textH1, { content: 'Text under H1', parentId: h1!.id, hasNoChildIds: true });
        assertBlockProperties(h2, { content: '## Header 2', parentId: h1!.id, numChildren: 1, hasChildIds: [textH2!.id!] });
        assertBlockProperties(textH2, { content: 'Text under H2', parentId: h2!.id, hasNoChildIds: true });

        assertParentChild(result, '# Header 1', 'Text under H1');
        assertParentChild(result, '# Header 1', '## Header 2');
        assertParentChild(result, '## Header 2', 'Text under H2');
      });

      it('3. Header with non-Indented List Item', () => {
        const markdown = `
# Header
- List item`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(2);

        const header = findBlock(result, '# Header');
        const listItem = findBlock(result, 'List item');

        assertBlockProperties(header, { content: '# Header', isRoot: true, numChildren: 1, hasChildIds: [listItem!.id!] });
        assertBlockProperties(listItem, { content: 'List item', parentId: header!.id, hasNoChildIds: true });
        assertParentChild(result, '# Header', 'List item');
      });

      it('3.1 Header with Indented List Item', () => {
        const markdown = `
# Header
  - List item`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(2);

        const header = findBlock(result, '# Header');
        const listItem = findBlock(result, 'List item');

        assertBlockProperties(header, { content: '# Header', isRoot: true, numChildren: 1, hasChildIds: [listItem!.id!] });
        assertBlockProperties(listItem, { content: 'List item', parentId: header!.id, hasNoChildIds: true });
        assertParentChild(result, '# Header', 'List item');
      });


      it('4. Header with Multiple Children (Indented)', () => {
        const markdown = `
# Header
  Line 1
  Line 2
    - List item
  Another line`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(5);

        const header = findBlock(result, '# Header');
        const line1 = findBlock(result, 'Line 1');
        const line2 = findBlock(result, 'Line 2'); 
        const listItem = findBlock(result, 'List item');  
        const anotherLine = findBlock(result, 'Another line'); 

        assertBlockProperties(header, { content: '# Header', isRoot: true, numChildren: 3, hasChildIds: [line1!.id!, line2!.id!, anotherLine!.id!] });
        assertBlockProperties(line1, { content: 'Line 1', parentId: header!.id, hasNoChildIds: true });
        assertBlockProperties(line2, { content: 'Line 2', parentId: header!.id, numChildren: 1, hasChildIds: [listItem!.id!] });
        assertBlockProperties(listItem, { content: 'List item', parentId: line2!.id, hasNoChildIds: true });
        assertBlockProperties(anotherLine, { content: 'Another line', parentId: header!.id, hasNoChildIds: true });

        assertParentChild(result, '# Header', 'Line 1');
        assertParentChild(result, '# Header', 'Line 2');
        assertParentChild(result, 'Line 2', 'List item');
        assertParentChild(result, '# Header', 'Another line');
      });

      it('5. Deeper Level Header (e.g., ###) and Child (Indented)', () => {
        const markdown = `
### Deep Header
  Text under deep header`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(2);
        
        const deepHeader = findBlock(result, '### Deep Header');
        const text = findBlock(result, 'Text under deep header');

        assertBlockProperties(deepHeader, { content: '### Deep Header', isRoot: true, numChildren: 1, hasChildIds: [text!.id!] });
        assertBlockProperties(text, { content: 'Text under deep header', parentId: deepHeader!.id, hasNoChildIds: true });
        assertParentChild(result, '### Deep Header', 'Text under deep header');
      });

      it('6. Mixed Content with Headers (aligning with current parser)', () => {
        const markdown = `
Plain text line 1
# Header 1
  Text under H1

Plain text line 2
## Header 2
  Text under H2
    Sub-item 1
    Sub-item 2`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(8);

        const plainText1 = findBlock(result, 'Plain text line 1');
        const h1 = findBlock(result, '# Header 1');
        const textH1 = findBlock(result, 'Text under H1');
        const plainText2 = findBlock(result, 'Plain text line 2'); 
        const h2 = findBlock(result, '## Header 2');
        const textH2 = findBlock(result, 'Text under H2');
        const subItem1 = findBlock(result, 'Sub-item 1'); 
        const subItem2 = findBlock(result, 'Sub-item 2'); 
        
        assertBlockProperties(plainText1, { content: 'Plain text line 1', isRoot: true, hasNoChildIds: true });
        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 1, hasChildIds: [textH1!.id!] });
        assertBlockProperties(textH1, { content: 'Text under H1', parentId: h1!.id, hasNoChildIds: true });
        assertBlockProperties(plainText2, { content: 'Plain text line 2', isRoot: true, hasNoChildIds: true });
        assertBlockProperties(h2, { content: '## Header 2', isRoot: true, numChildren: 1, hasChildIds: [textH2!.id!] });
        assertBlockProperties(textH2, { content: 'Text under H2', parentId: h2!.id, numChildren: 2, hasChildIds: [subItem1!.id!, subItem2!.id!] });
        assertBlockProperties(subItem1, { content: 'Sub-item 1', parentId: textH2!.id, hasNoChildIds: true });
        assertBlockProperties(subItem2, { content: 'Sub-item 2', parentId: textH2!.id, hasNoChildIds: true });

        assertParentChild(result, '# Header 1', 'Text under H1');
        assertParentChild(result, '## Header 2', 'Text under H2');
        assertParentChild(result, 'Text under H2', 'Sub-item 1');
        assertParentChild(result, 'Text under H2', 'Sub-item 2');
      });

      it('7. Header at the End of Input', () => {
        const markdown = `
Some text
# Final Header`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(2);
        
        const someText = findBlock(result, 'Some text');
        const finalHeader = findBlock(result, '# Final Header');

        assertBlockProperties(someText, { content: 'Some text', isRoot: true, hasNoChildIds: true });
        assertBlockProperties(finalHeader, { content: '# Final Header', isRoot: true, hasNoChildIds: true });
      });

      it('8. Input with Only Headers (aligning with new hierarchical parsing)', () => {
        const markdown = `
# Header 1
## Header 2
### Header 3`;
        const result = parseMarkdownToBlocks(markdown);
        expect(result).toHaveLength(3);

        const h1 = findBlock(result, '# Header 1');
        const h2 = findBlock(result, '## Header 2');
        const h3 = findBlock(result, '### Header 3');

        assertBlockProperties(h1, { content: '# Header 1', isRoot: true, numChildren: 1, hasChildIds: [h2!.id!] });
        assertBlockProperties(h2, { content: '## Header 2', parentId: h1!.id, numChildren: 1, hasChildIds: [h3!.id!] });
        assertBlockProperties(h3, { content: '### Header 3', parentId: h2!.id, hasNoChildIds: true });
        
        assertParentChild(result, '# Header 1', '## Header 2');
        assertParentChild(result, '## Header 2', '### Header 3');
      });
    })
  })
})
