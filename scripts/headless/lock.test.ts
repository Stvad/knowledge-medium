import {execFile} from 'node:child_process'
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {afterEach, beforeEach, expect, it} from 'vitest'
import {acquirePidfile} from '../../packages/agent-dispatch/src/pidfile'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'headless-lock-')) })
afterEach(async () => { await rm(dir, {recursive: true, force: true}) })

it.each(['run', 'login'])('%s on a held state directory exits before opening storage', async action => {
  const stateDir = join(dir, 'device')
  const config = join(dir, 'config.json')
  await writeFile(config, JSON.stringify({workspaceId: 'fixture', profile: 'test', mode: 'plaintext', stateDir}))
  await mkdir(stateDir, {mode: 0o700})
  await acquirePidfile({file: join(stateDir, 'headless.pid')})
  const child = promisify(execFile)(process.execPath, [join(import.meta.dirname, 'launch.ts'), action, config], {
    env: {PATH: process.env.PATH},
  })
  await expect(child).rejects.toMatchObject({code: 1, stderr: expect.stringContaining('Another headless is already running')})
  expect(await readdir(stateDir)).toEqual(['headless.pid'])
})
