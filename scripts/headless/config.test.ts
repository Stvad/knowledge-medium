import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect, it} from 'vitest'
import {readConfig} from './config'

it('keeps old configs read-only and accepts only a boolean opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'headless-config-'))
  const file = join(dir, 'headless.json')
  const config = {mode: 'plaintext', workspaceId: 'workspace', profile: 'fixture', stateDir: 'state'}
  const read = async (writable?: unknown) => {
    await writeFile(file, JSON.stringify({...config, writable}))
    return readConfig(file)
  }
  try {
    await expect(read()).resolves.toMatchObject({writable: false})
    await expect(read(true)).resolves.toMatchObject({writable: true})
    await expect(read('false')).rejects.toThrow('writable')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
