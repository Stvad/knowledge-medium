import { describe, it, expect } from 'vitest'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'

describe('markdownParser', () => {

  describe('parseMarkdownToBlocks', () => {
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
      expect(result[1].content).toBe('Child')
      expect(result[2].content).toBe('Grandchild')

      // Check parent-child relationships
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
      expect(result[0].content).toBe('First item')
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item')

      // Check parent-child relationships
      expect(result[1].parentId).toBe(undefined)
      expect(result[2].parentId).toBe(result[1].id)
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

      // Check parent-child relationships
      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[0].id)
      expect(result[2].childIds).toContain(result[3].id)
      expect(result[1].childIds).toHaveLength(0)
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
      expect(result[1].content).toBe('First item')
      expect(result[2].content).toBe('Nested item')
      expect(result[3].content).toBe('Second item')

      // Check parent-child relationships
      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[1].id)
      expect(result[3].parentId).toBe(result[0].id)
    })

    it('should handle numbered lists', () => {
      const markdown = `1. First item
2. Second item
   1. Nested item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('First item')
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item')
    })

    it('should set default properties', () => {
      const markdown = 'Single line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(1)
      expect(result[0].childIds).toEqual([])
    })

    // Helper function to find a block by its content
    const findBlockByContent = (blocks: Partial<ReturnType<typeof parseMarkdownToBlocks>[0]>[], content: string) => {
      return blocks.find(block => block.content === content)
    }

    describe('Markdown Header Parsing', () => {
      it('1. Basic Header and Child', () => {
        const markdown = `# Header 1\nText under header`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(2)
        const header1 = findBlockByContent(result, 'Header 1')
        const textUnderHeader = findBlockByContent(result, 'Text under header')

        expect(header1).toBeDefined()
        expect(textUnderHeader).toBeDefined()

        expect(header1?.parentId).toBeUndefined()
        expect(textUnderHeader?.parentId).toBe(header1?.id)
        expect(header1?.childIds).toContain(textUnderHeader?.id)
      })

      it('2. Multiple Headers', () => {
        const markdown = `# Header 1\nText under H1\n## Header 2\nText under H2`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(4)
        const header1 = findBlockByContent(result, 'Header 1')
        const textUnderH1 = findBlockByContent(result, 'Text under H1')
        const header2 = findBlockByContent(result, 'Header 2') // Content is "Header 2" after "## " is stripped
        const textUnderH2 = findBlockByContent(result, 'Text under H2')

        expect(header1).toBeDefined()
        expect(textUnderH1).toBeDefined()
        expect(header2).toBeDefined()
        expect(textUnderH2).toBeDefined()

        expect(header1?.parentId).toBeUndefined()
        expect(textUnderH1?.parentId).toBe(header1?.id)
        expect(header1?.childIds).toContain(textUnderH1?.id)

        expect(header2?.parentId).toBeUndefined() // Headers are siblings if not indented under text
        expect(textUnderH2?.parentId).toBe(header2?.id)
        expect(header2?.childIds).toContain(textUnderH2?.id)
      })

      it('3. Header with Indented List Item', () => {
        const markdown = `# Header\n  - List item`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(2)
        const header = findBlockByContent(result, 'Header')
        const listItem = findBlockByContent(result, '  - List item') // Content includes leading spaces and marker

        expect(header).toBeDefined()
        expect(listItem).toBeDefined()

        expect(header?.parentId).toBeUndefined()
        expect(listItem?.parentId).toBe(header?.id)
        expect(header?.childIds).toContain(listItem?.id)
        expect(listItem?.content).toBe('  - List item')
      })

      it('4. Header with Multiple Children', () => {
        const markdown = `# Header\nLine 1\nLine 2\n  - List item\nAnother line`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(5)
        const header = findBlockByContent(result, 'Header')
        const line1 = findBlockByContent(result, 'Line 1')
        const line2 = findBlockByContent(result, 'Line 2')
        const listItem = findBlockByContent(result, '  - List item')
        const anotherLine = findBlockByContent(result, 'Another line')

        expect(header).toBeDefined()
        expect(line1).toBeDefined()
        expect(line2).toBeDefined()
        expect(listItem).toBeDefined()
        expect(anotherLine).toBeDefined()

        expect(header?.parentId).toBeUndefined()
        expect(line1?.parentId).toBe(header?.id)
        expect(line2?.parentId).toBe(header?.id)
        expect(listItem?.parentId).toBe(header?.id)
        expect(anotherLine?.parentId).toBe(header?.id)

        expect(header?.childIds).toContain(line1?.id)
        expect(header?.childIds).toContain(line2?.id)
        expect(header?.childIds).toContain(listItem?.id)
        expect(header?.childIds).toContain(anotherLine?.id)
        expect(listItem?.content).toBe('  - List item')
      })

      it('5. Deeper Level Header (e.g., ###) and Child', () => {
        const markdown = `### Deep Header\nText under deep header`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(2)
        const deepHeader = findBlockByContent(result, 'Deep Header')
        const textUnderDeepHeader = findBlockByContent(result, 'Text under deep header')

        expect(deepHeader).toBeDefined()
        expect(textUnderDeepHeader).toBeDefined()

        expect(deepHeader?.parentId).toBeUndefined()
        expect(textUnderDeepHeader?.parentId).toBe(deepHeader?.id)
        expect(deepHeader?.childIds).toContain(textUnderDeepHeader?.id)
        expect(deepHeader?.content).toBe('Deep Header') // Ensure ### is stripped
      })

      it('6. Mixed Content with Headers', () => {
        const markdown = `Plain text line 1\n# Header 1\nText under H1\n\nPlain text line 2\n## Header 2\nText under H2\n  Sub-item 1\n  Sub-item 2`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(8)
        const plainText1 = findBlockByContent(result, 'Plain text line 1')
        const header1 = findBlockByContent(result, 'Header 1')
        const textUnderH1 = findBlockByContent(result, 'Text under H1')
        const plainText2 = findBlockByContent(result, 'Plain text line 2')
        const header2 = findBlockByContent(result, 'Header 2')
        const textUnderH2 = findBlockByContent(result, 'Text under H2')
        const subItem1 = findBlockByContent(result, '  Sub-item 1')
        const subItem2 = findBlockByContent(result, '  Sub-item 2')

        expect(plainText1).toBeDefined()
        expect(header1).toBeDefined()
        expect(textUnderH1).toBeDefined()
        expect(plainText2).toBeDefined()
        expect(header2).toBeDefined()
        expect(textUnderH2).toBeDefined()
        expect(subItem1).toBeDefined()
        expect(subItem2).toBeDefined()

        // Plain text line 1
        expect(plainText1?.parentId).toBeUndefined()

        // Header 1 and its child
        expect(header1?.parentId).toBeUndefined()
        expect(textUnderH1?.parentId).toBe(header1?.id)
        expect(header1?.childIds).toContain(textUnderH1?.id)

        // Plain text line 2 (after empty line, so top-level)
        expect(plainText2?.parentId).toBeUndefined()

        // Header 2 and its children
        expect(header2?.parentId).toBeUndefined()
        expect(textUnderH2?.parentId).toBe(header2?.id)
        expect(subItem1?.parentId).toBe(header2?.id)
        expect(subItem2?.parentId).toBe(header2?.id)
        expect(header2?.childIds).toContain(textUnderH2?.id)
        expect(header2?.childIds).toContain(subItem1?.id)
        expect(header2?.childIds).toContain(subItem2?.id)

        expect(subItem1?.content).toBe('  Sub-item 1')
        expect(subItem2?.content).toBe('  Sub-item 2')
      })

      it('7. Header at the End of Input', () => {
        const markdown = `Some text\n# Final Header`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(2)
        const someText = findBlockByContent(result, 'Some text')
        const finalHeader = findBlockByContent(result, 'Final Header')

        expect(someText).toBeDefined()
        expect(finalHeader).toBeDefined()

        expect(someText?.parentId).toBeUndefined()
        expect(finalHeader?.parentId).toBeUndefined() // Should be sibling to "Some text"
        expect(finalHeader?.childIds).toEqual([])
      })

      it('8. Input with Only Headers (Revised Expectation)', () => {
        const markdown = `# Header 1\n## Header 2\n### Header 3`
        const result = parseMarkdownToBlocks(markdown)

        expect(result).toHaveLength(3)
        const header1 = findBlockByContent(result, 'Header 1')
        const header2 = findBlockByContent(result, 'Header 2')
        const header3 = findBlockByContent(result, 'Header 3')

        expect(header1).toBeDefined()
        expect(header2).toBeDefined()
        expect(header3).toBeDefined()

        // All headers are top-level siblings because no text follows them to become children
        // and the parser logic makes lines *following* a header its children.
        // One header following another doesn't make the second a child of the first by default.
        expect(header1?.parentId).toBeUndefined()
        expect(header1?.childIds).toEqual([])

        expect(header2?.parentId).toBeUndefined()
        expect(header2?.childIds).toEqual([])

        expect(header3?.parentId).toBeUndefined()
        expect(header3?.childIds).toEqual([])
      })
    })
  })
})
