import { describe, expect, it, vi } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'

vi.mock('mdast-util-from-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('mdast-util-from-markdown')>()
  return {...actual, fromMarkdown: vi.fn(actual.fromMarkdown)}
})

/** Lines handed to the GFM parser by each call. */
const parsedLineCounts = (): number[] =>
  vi.mocked(fromMarkdown).mock.calls.map(([value]) => String(value).split('\n').length)

describe('parseMarkdownToBlocks: table detection cost', () => {
  it('parses only the header and delimiter of a candidate that is not a table', () => {
    vi.mocked(fromMarkdown).mockClear()
    // Header/delimiter pairs whose column counts disagree, back to back.
    const malformed = Array.from({length: 200}, (_, i) => `| a${i} | b${i} |\n| --- |`).join('\n')

    const blocks = parseMarkdownToBlocks(malformed)

    expect(blocks).toHaveLength(400)
    expect(Math.max(...parsedLineCounts())).toBe(2)
  })

  it('parses each row with only the header and delimiter, however long the pipe run', () => {
    vi.mocked(fromMarkdown).mockClear()
    // Tables each ended by a block that also carries a pipe.
    const tables = Array.from({length: 200}, (_, i) => `| a${i} | b |\n| - | - |\n- c${i} | d`).join('\n')

    const blocks = parseMarkdownToBlocks(tables)

    expect(blocks).toHaveLength(400)
    expect(Math.max(...parsedLineCounts())).toBe(3)
  })

  it('parses the header once, not with every row', () => {
    vi.mocked(fromMarkdown).mockClear()
    const header = `| ${Array.from({length: 300}, (_, i) => `column ${i}`).join(' | ')} |`
    const delimiter = `|${' - |'.repeat(300)}`

    parseMarkdownToBlocks([header, delimiter, ...Array.from({length: 200}, (_, i) => `| ${i} |`)].join('\n'))

    const [first, ...rows] = vi.mocked(fromMarkdown).mock.calls.map(([value]) => String(value).length)
    expect(first).toBeGreaterThan(header.length)
    expect(Math.max(...rows)).toBeLessThan(40)
  })

  it('parses a table row by row', () => {
    vi.mocked(fromMarkdown).mockClear()
    const table = '| a | b |\n| - | - |\n| 1 | 2 |'

    parseMarkdownToBlocks(`${table}\nafter the table\n${'x\n'.repeat(500)}`)

    expect(parsedLineCounts()).toEqual([2, 3])
  })
})
