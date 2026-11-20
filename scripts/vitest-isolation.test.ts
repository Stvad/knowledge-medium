import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ISOLATED_FILES, listIsolatedTestFiles, needsOwnWorker } from './vitest-isolation'

describe('needsOwnWorker', () => {
  it.each([
    ['plain logic', 'it("a", () => {})', false],
    ['an explicit node docblock', '// @vitest-environment node', false],
    ['a vi.fn', 'const f = vi.fn()', false],
    ['a vi.mocked', 'vi.mocked(f).mockReturnValue(1)', false],
    ['a happy-dom docblock', '// @vitest-environment happy-dom\nit("a", () => {})', true],
    ['a block-comment docblock', '/** @vitest-environment happy-dom */', true],
    ['a jsdom docblock', '// @vitest-environment jsdom', true],
    ['a jest-style docblock', '// @jest-environment happy-dom', true],
    ['a vi.mock', 'vi.mock("@/a.js", () => ({}))', true],
    ['a vi.doMock', 'vi.doMock("@/a.js")', true],
    ['a vi.unmock', 'vi.unmock("@/a.js")', true],
    ['a vi.resetModules', 'vi.resetModules()', true],
  ])('%s', (_name, source, expected) => {
    expect(needsOwnWorker(source)).toBe(expected)
  })
})

describe('listIsolatedTestFiles', () => {
  it('keeps every explicit entry on disk, so a rename cannot quietly share the file', () => {
    for (const path of Object.keys(ISOLATED_FILES)) expect(existsSync(path), path).toBe(true)
  })

  it('lists every explicit entry whatever the rules say about it', () => {
    expect(listIsolatedTestFiles('no-such-file.test.ts', process.cwd())).toEqual(Object.keys(ISOLATED_FILES))
  })

  it('finds a file by rule, as a root-relative path', () => {
    expect(listIsolatedTestFiles('scripts/vitest-isolation.test.ts', process.cwd())).toContain('scripts/vitest-isolation.test.ts')
  })
})
