import {afterEach, describe, expect, it, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {contributorSelectionPath, loadContributorSelection, parseContributorSelection, saveContributorSelection} from '../src/config.js'

describe('CLI contributor selections', () => {
  const previousDirectory = process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR
  let directory: string

  afterEach(async () => {
    vi.restoreAllMocks()
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
    expect(path.dirname(contributorSelectionPath('valid-profile', 'workspace/../a'))).toBe(directory)
  })

  it('loads a canonical save through padded profile and workspace names', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await saveContributorSelection('work', 'workspace-a', 'contributor-a')

    expect(await loadContributorSelection(' work ', ' workspace-a ')).toBe('contributor-a')
    expect(contributorSelectionPath(' work ', ' workspace-a '))
      .toBe(contributorSelectionPath('work', 'workspace-a'))
  })

  it('loads a padded save through canonical profile and workspace names', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await saveContributorSelection(' work ', ' workspace-a ', 'contributor-a')

    expect(await loadContributorSelection('work', 'workspace-a')).toBe('contributor-a')
    expect(contributorSelectionPath(' work ', ' workspace-a '))
      .toBe(contributorSelectionPath('work', 'workspace-a'))
  })

  it.each([
    ['profile case', 'Work', 'work', 'workspace-a', 'contributor-upper-profile', 'contributor-lower-profile'],
    ['workspace case', 'work', 'work', 'Workspace-a', 'contributor-upper-workspace', 'contributor-lower-workspace'],
  ])('keeps case-sensitive %s selections on distinct portable paths', async (
    _label, firstProfile, secondProfile, secondWorkspace, firstId, secondId,
  ) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await saveContributorSelection(firstProfile, 'workspace-a', firstId)
    await saveContributorSelection(secondProfile, secondWorkspace, secondId)

    expect(await loadContributorSelection(firstProfile, 'workspace-a')).toBe(firstId)
    expect(await loadContributorSelection(secondProfile, secondWorkspace)).toBe(secondId)
    expect(contributorSelectionPath(firstProfile, 'workspace-a').toLowerCase())
      .not.toBe(contributorSelectionPath(secondProfile, secondWorkspace).toLowerCase())
  })

  it('maps a blank profile to default and round-trips explicit none in one file', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory

    await saveContributorSelection('', 'workspace-a', null)

    expect(contributorSelectionPath('   ', 'workspace-a')).toBe(contributorSelectionPath('default', 'workspace-a'))
    expect(await loadContributorSelection('default', 'workspace-a')).toBeNull()
    expect(await fs.readdir(directory)).toEqual([path.basename(contributorSelectionPath('default', 'workspace-a'))])
  })

  it('refuses invalid profiles and blank workspaces before reading or writing files', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contributor-selection-'))
    process.env.AGENT_RUNTIME_CONTRIBUTOR_DIR = directory
    const readFile = vi.spyOn(fs, 'readFile')
    const mkdir = vi.spyOn(fs, 'mkdir')

    const results: Array<{pathRejected: boolean; loadRejected: boolean; saveRejected: boolean}> = []
    for (const [profile, workspaceId] of [['../profile', 'workspace-a'], ['work', '   ']] as const) {
      let pathRejected = false
      try { contributorSelectionPath(profile, workspaceId) } catch { pathRejected = true }
      const [loaded, saved] = await Promise.allSettled([
        loadContributorSelection(profile, workspaceId),
        saveContributorSelection(profile, workspaceId, 'contributor-a'),
      ])
      results.push({pathRejected, loadRejected: loaded.status === 'rejected', saveRejected: saved.status === 'rejected'})
    }
    expect(results).toEqual([
      {pathRejected: true, loadRejected: true, saveRejected: true},
      {pathRejected: true, loadRejected: true, saveRejected: true},
    ])
    expect(readFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual([])
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
