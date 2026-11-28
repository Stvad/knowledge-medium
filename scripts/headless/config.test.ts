import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, expect, it, vi} from 'vitest'
import {readConfig} from './config'

let dir: string
const read = async (config: object) => {
  const file = join(dir, 'headless.json')
  await writeFile(file, JSON.stringify(config))
  return readConfig(file)
}
const common = {workspaceId: 'workspace', profile: 'fixture', stateDir: 'state'}
const command = ['security', 'find-generic-password', '-w']

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'headless-config-'))
})
afterAll(async () => {
  await rm(dir, {recursive: true, force: true})
})

it('keeps old configs read-only and accepts only a boolean opt-in', async () => {
  const config = {...common, mode: 'plaintext'}
  await expect(read(config)).resolves.toMatchObject({writable: false})
  await expect(read({...config, writable: true})).resolves.toMatchObject({writable: true})
  await expect(read({...config, writable: 'false'})).rejects.toThrow('writable')
})

it('resolves a key file beside the config and keeps a key command as given', async () => {
  await expect(read({...common, mode: 'e2ee', keyFile: 'workspace.key'}))
    .resolves.toMatchObject({keyFile: join(dir, 'workspace.key')})
  const config = await read({...common, mode: 'e2ee', keyCommand: command})
  expect(config).toMatchObject({keyCommand: command})
  expect(config).not.toHaveProperty('keyFile')
  await expect(read({...common, mode: 'e2ee', keyCommand: ['./get-key', './arg']}))
    .resolves.toMatchObject({keyCommand: [join(dir, 'get-key'), './arg']})
})

it.each([
  ['both key sources', {keyFile: 'workspace.key', keyCommand: command}, 'exactly one of keyFile or keyCommand'],
  ['neither key source', {}, 'exactly one of keyFile or keyCommand'],
  ['an empty key command', {keyCommand: []}, '"keyCommand"'],
  ['an empty program name', {keyCommand: [' ']}, '"keyCommand"'],
])('refuses an encrypted config with %s', async (_, source, message) => {
  await expect(read({...common, mode: 'e2ee', ...source})).rejects.toThrow(message)
})

it('refuses a key command on a plaintext config', async () => {
  await expect(read({...common, mode: 'plaintext', keyCommand: command})).rejects.toThrow('keyCommand')
})

it('resolves reviewed copies beside the config and rejects ambiguous grants', async () => {
  const config = {...common, mode: 'plaintext'}
  const entry = {block: 'fixture-block', file: 'reviewed.tsx'}
  await expect(read({...config, extensions: [entry]})).resolves.toMatchObject({
    extensions: [{...entry, file: join(dir, entry.file)}],
  })
  await expect(read({...config, extensions: [entry, {...entry, file: 'other.ts'}]}))
    .rejects.toThrow('Each extension block must be listed only once')
  await expect(read({...config, extensions: [{...entry, source: 'export default null'}]})).rejects.toThrow('source')
})

it.each([['group', 0o620], ['other', 0o602]] as const)('refuses a config writable by %s', async (_, mode) => {
  const file = join(dir, 'writable-config.json')
  await writeFile(file, JSON.stringify({...common, mode: 'plaintext'}))
  await chmod(file, mode)
  await expect(readConfig(file)).rejects.toThrow(/^config-file-permissions$/)
})

it('refuses a config owned by a different effective user', async () => {
  const file = join(dir, 'foreign-config.json')
  await writeFile(file, JSON.stringify({...common, mode: 'plaintext'}), {mode: 0o600})
  await expect(readConfig(file)).resolves.toMatchObject({mode: 'plaintext'})
  const owner = vi.spyOn(process, 'geteuid').mockReturnValue(process.geteuid!() + 1)
  try {
    await expect(readConfig(file)).rejects.toThrow(/^config-file-permissions$/)
  } finally {
    owner.mockRestore()
  }
})

it('reports an unreadable config without printing its file path', async () => {
  await expect(readConfig(join(dir, 'missing-config.json'))).rejects.toThrow(/^config-file-unreadable$/)
})
