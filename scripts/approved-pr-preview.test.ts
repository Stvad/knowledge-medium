import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvePreview, parsePrNumber, validatePreviewArtifact } from './approved-pr-preview.ts'

const repository = 'owner/project'
const sha = 'a'.repeat(40)
const pull = () => ({
  number: 42,
  state: 'open',
  base: { ref: 'master', repo: { full_name: repository } },
  head: { sha, repo: { full_name: 'contributor/fork' } },
})

function approve(getPull = vi.fn(async () => pull()), prNumber = '42', headSha = sha) {
  return approvePreview({ prNumber, headSha, repository, getPull })
}

describe('commit-pinned preview approval', () => {
  it('resolves the reviewed head from the requested PR, including fork checkout and base path', async () => {
    const getPull = vi.fn(async () => pull())
    await expect(approve(getPull)).resolves.toEqual({
      number: 42, sha, repository: 'contributor/fork', basePath: '/project/pr-preview/pr-42/',
    })
    expect(getPull).toHaveBeenCalledExactlyOnceWith(42)
  })

  it.each(['0', '-1', '042', '1e3', '42/foo', '42\n', '9007199254740992'])('rejects unsafe PR number %j', value => {
    expect(() => parsePrNumber(value)).toThrow('positive integer')
  })

  it.each(['master', 'a'.repeat(7), 'A'.repeat(40), `${sha}\n`, `${sha}; echo bad`])('rejects noncanonical SHA %j before fetching', async value => {
    const getPull = vi.fn(async () => pull())
    await expect(approve(getPull, '42', value)).rejects.toThrow('40-character')
    expect(getPull).not.toHaveBeenCalled()
  })

  it('refuses a different PR even when its head matches', async () => {
    await expect(approve(vi.fn(async () => ({ ...pull(), number: 43 })))).rejects.toThrow('requested PR')
  })

  it('refuses closed PRs', async () => {
    await expect(approve(vi.fn(async () => ({ ...pull(), state: 'closed' })))).rejects.toThrow('open')
  })

  it('refuses a different target branch', async () => {
    const pr = pull()
    pr.base.ref = 'release'
    await expect(approve(vi.fn(async () => pr))).rejects.toThrow('master')
  })

  it('refuses a different target repository', async () => {
    const pr = pull()
    pr.base.repo.full_name = 'another/project'
    await expect(approve(vi.fn(async () => pr))).rejects.toThrow('target repository')
  })

  it('re-fetches and refuses a push after the initial approval', async () => {
    const getPull = vi.fn(async () => pull())
    await approve(getPull)
    getPull.mockResolvedValueOnce({ ...pull(), head: { ...pull().head, sha: 'b'.repeat(40) } })
    await expect(approve(getPull)).rejects.toThrow('head has changed')
    expect(getPull).toHaveBeenCalledTimes(2)
  })

  it('refuses a deleted head repository', async () => {
    await expect(approvePreview({ prNumber: '42', headSha: sha, repository,
      getPull: async () => ({ ...pull(), head: { sha, repo: null } }),
    })).rejects.toThrow('head repository')
  })
})

const directories: string[] = []
function artifact() {
  const dir = mkdtempSync(join(tmpdir(), 'approved-preview-'))
  directories.push(dir)
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ sha: sha.slice(0, 12) }))
  return dir
}
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe('static preview artifact boundary', () => {
  it('accepts ordinary assets and the Pages marker', () => {
    const dir = artifact()
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("preview")')
    writeFileSync(join(dir, '.nojekyll'), '')
    expect(() => validatePreviewArtifact(dir)).not.toThrow()
  })

  it.each(['.git', '.git/config', 'assets/.gitattributes', '.github/workflows/publish.yml'])('rejects Git control files %s', name => {
    const dir = artifact()
    const parts = name.split('/')
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, name), 'malicious')
    expect(() => validatePreviewArtifact(dir)).toThrow('Git control')
  })

  it('rejects symlinks even when they point to regular files', () => {
    const dir = artifact()
    symlinkSync(join(dir, 'index.html'), join(dir, 'link.html'))
    expect(() => validatePreviewArtifact(dir)).toThrow('regular files')
  })

  it.each(['index.html', 'version.json'])('rejects incomplete builds missing %s', file => {
    const dir = artifact()
    rmSync(join(dir, file))
    expect(() => validatePreviewArtifact(dir)).toThrow()
  })
})
