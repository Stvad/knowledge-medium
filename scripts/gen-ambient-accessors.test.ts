import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseAllowIn,
  quote,
  renderEntry,
  renderGeneratedSpan,
  replaceGeneratedSpan,
  SRC_DIR,
  toModuleSpecifier,
} from './gen-ambient-accessors'

describe('parseAllowIn', () => {
  it('splits a comma-separated allowIn list and trims whitespace', () => {
    expect(parseAllowIn('allowIn: a.ts, b.ts,  c.ts')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns an empty array for a bare/empty tag', () => {
    expect(parseAllowIn('allowIn:')).toEqual([])
    expect(parseAllowIn('')).toEqual([])
  })
})

describe('toModuleSpecifier', () => {
  it('derives the @/-style specifier from an absolute src/ path', () => {
    expect(toModuleSpecifier(resolve(SRC_DIR, 'data/repoProvider.ts'))).toBe('@/data/repoProvider')
  })

  it('strips .tsx the same way', () => {
    expect(toModuleSpecifier(resolve(SRC_DIR, 'components/Foo.tsx'))).toBe('@/components/Foo')
  })
})

describe('quote', () => {
  it('wraps in single quotes', () => {
    expect(quote('hello')).toBe(`'hello'`)
  })

  it('escapes embedded single quotes and backslashes', () => {
    expect(quote(`it's a \\test`)).toBe(`'it\\'s a \\\\test'`)
  })
})

describe('renderEntry', () => {
  it('renders a single-allowIn entry inline', () => {
    const rendered = renderEntry({
      kind: 'import',
      module: '@/data/repoProvider',
      names: ['getActiveUserId'],
      message: 'use repo.user.id instead',
      allowIn: ['src/data/repoProvider.ts'],
    })
    expect(rendered).toBe(
      [
        '  {',
        `    kind: 'import',`,
        `    module: '@/data/repoProvider',`,
        `    names: ['getActiveUserId'],`,
        `    message: 'use repo.user.id instead',`,
        `    allowIn: ['src/data/repoProvider.ts'],`,
        '  },',
      ].join('\n'),
    )
  })

  it('renders a multi-allowIn entry one path per line', () => {
    const rendered = renderEntry({
      kind: 'import',
      module: '@/data/repoProvider',
      names: ['getActiveUserId'],
      message: 'use repo.user.id instead',
      allowIn: ['src/data/repoProvider.ts', 'src/plugins/attachments/assetUpload.ts'],
    })
    expect(rendered).toContain('    allowIn: [\n      \'src/data/repoProvider.ts\',\n      \'src/plugins/attachments/assetUpload.ts\',\n    ],')
  })
})

describe('renderGeneratedSpan + replaceGeneratedSpan', () => {
  const entry = {
    kind: 'import' as const,
    module: '@/data/repoProvider',
    names: ['getActiveUserId'],
    message: 'use repo.user.id instead',
    allowIn: ['src/data/repoProvider.ts'],
  }

  it('regenerating from its own output is a no-op (idempotent)', () => {
    const span = renderGeneratedSpan([entry])
    const table = `// header\n\n${span}\n\nexport const manualEntries = []\n`
    expect(replaceGeneratedSpan(table, span)).toBe(table)
  })

  it('replaces ONLY the marked span, leaving manualEntries untouched', () => {
    const before = renderGeneratedSpan([entry])
    const table = `// header\n\n${before}\n\nexport const manualEntries = [{kind: 'member'}]\n`
    const after = renderGeneratedSpan([{...entry, names: ['getActiveUserId', 'other']}])
    const result = replaceGeneratedSpan(table, after)
    expect(result).toContain(`names: ['getActiveUserId', 'other']`)
    expect(result).toContain(`export const manualEntries = [{kind: 'member'}]`)
  })

  it('throws when the markers are missing (hand-edited past recovery)', () => {
    expect(() => replaceGeneratedSpan('export const manualEntries = []', 'span')).toThrow(/BEGIN\/END/)
  })
})
