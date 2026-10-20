import {afterEach, describe, expect, it} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {contributorSelectionPath, loadContributorSelection, parseContributorSelection, saveContributorSelection} from '../src/config.js'

describe('CLI contributor selections', () => {
  const previousDirectory = process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR
  let directory: string

  afterEach(async () => {
    if (previousDirectory === undefined) delete process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR
    else process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = previousDirectory
    if (directory) await fs.rm(directory, {recursive: true, force: true})
  })

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['none', null],
    [' none ', null],
    [' contributor-1 ', 'contributor-1'],
  ] as const)('parses explicit contributor setting %j like the MCP server', (value, expected) => {
    expect(parseContributorSelection(value)).toBe(expected)
  })

  it('updates different profile/workspace choices concurrently without losing either', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await Promise.all([
      saveContributorSelection('default', 'workspace-a', 'contributor-a'),
      saveContributorSelection('default', 'workspace-b', null),
      saveContributorSelection('work', 'workspace-a', 'contributor-b'),
    ])

    expect(await loadContributorSelection('default', 'workspace-a')).toBe('contributor-a')
    expect(await loadContributorSelection('default', 'workspace-b')).toBeNull()
    expect(await loadContributorSelection('work', 'workspace-a')).toBe('contributor-b')
    expect(await loadContributorSelection('work', 'workspace-b')).toBeUndefined()
    for (const target of [
      contributorSelectionPath('default', 'workspace-a'),
      contributorSelectionPath('default', 'workspace-b'),
      contributorSelectionPath('work', 'workspace-a'),
    ]) {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
    }
    expect(contributorSelectionPath('a--b', 'c')).not.toBe(contributorSelectionPath('a', 'b--c'))
    expect(path.dirname(contributorSelectionPath('../profile', 'workspace/../a'))).toBe(directory)
  })

  it('atomically replaces one profile/workspace selection without leaving temporary files', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await saveContributorSelection('work', 'workspace-a', 'initial')
    await Promise.all(['one', 'two', 'three'].map(id => saveContributorSelection('work', 'workspace-a', id)))

    expect(['one', 'two', 'three']).toContain(await loadContributorSelection('work', 'workspace-a'))
    expect(await fs.readdir(directory)).toEqual([path.basename(contributorSelectionPath('work', 'workspace-a'))])
  })

  it('refuses a blank contributor id in saved data instead of treating it as an attribution choice', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory
    const file = contributorSelectionPath('work', 'workspace-a')
    await fs.writeFile(file, JSON.stringify({contributorId: '   '}))

    await expect(loadContributorSelection('work', 'workspace-a')).rejects.toThrow(/Invalid contributor selection file/)
    await expect(saveContributorSelection('work', 'workspace-a', '')).rejects.toThrow(/non-empty/)
  })
})
