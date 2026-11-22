import {execFile} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

const run = promisify(execFile)
const viteNode = createRequire(import.meta.url).resolve('vite-node/cli')

it('restores the rotated session in a new process and signs out when refresh is refused after expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'headless-auth-'))
  try {
    for (const step of ['refresh', 'restore']) {
      const {stdout} = await run(process.execPath, [
        '--experimental-webstorage', `--localstorage-file=${join(dir, 'device')}`,
        viteNode, '--config', 'scripts/headless/vite.config.ts', 'scripts/headless/test/authStorageProbe.ts', '--', step,
      ], {
        env: {VITE_SUPABASE_URL: 'https://test.invalid', VITE_SUPABASE_ANON_KEY: 'test-public-key'},
        timeout: 15_000,
      })
      expect(stdout.trim()).toBe(step)
    }
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}, 40_000)
