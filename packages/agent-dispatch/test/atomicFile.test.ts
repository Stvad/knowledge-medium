import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {createFileExclusive} from '../src/atomicFile'

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-atomic-'))
})
afterAll(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})
beforeEach(async () => {
  for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), {recursive: true, force: true})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('createFileExclusive', () => {
  it('creates an absent file with the requested mode and returns true', async () => {
    const file = path.join(dir, 'secret')
    expect(await createFileExclusive(file, 'hello\n', {mode: 0o600})).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('hello\n')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    // No temp files left behind.
    expect((await fs.readdir(dir)).filter(n => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('returns false and leaves existing content intact when the file already exists', async () => {
    const file = path.join(dir, 'secret')
    await createFileExclusive(file, 'first\n')
    expect(await createFileExclusive(file, 'second\n')).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('first\n')
  })

  it('concurrent creators converge on exactly one winner', async () => {
    const file = path.join(dir, 'secret')
    const results = await Promise.all(
      Array.from({length: 12}, (_, i) => createFileExclusive(file, `content-${i}\n`)),
    )
    // Exactly one call created the file; the winner's content is what's on disk.
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results.indexOf(true)
    expect(await fs.readFile(file, 'utf8')).toBe(`content-${winner}\n`)
  })

  it('surfaces an actionable error when the filesystem lacks hardlink support', async () => {
    const file = path.join(dir, 'secret')
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('nope'), {code: 'EOPNOTSUPP'}))
    const error = await createFileExclusive(file, 'x\n').then(
      () => null,
      (e: unknown) => e as {message: string, cause?: {code?: string}},
    )
    expect(error?.message).toMatch(/hardlinks/)
    // The originating errno is preserved as the cause, and the temp is cleaned up.
    expect(error?.cause?.code).toBe('EOPNOTSUPP')
    expect((await fs.readdir(dir)).filter(n => n.endsWith('.tmp'))).toHaveLength(0)
  })
})
