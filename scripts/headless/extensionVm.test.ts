import {execFile} from 'node:child_process'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {it} from 'vitest'

it('rechecks linked import edges and writable admission inside the native VM', async () => {
  // Sources passed directly to the instantiator exercise its boundary even
  // when the compiler would have refused the same edge first.
  await promisify(execFile)(process.execPath, [
    '--experimental-vm-modules', fileURLToPath(import.meta.resolve('vite-node/cli')),
    '--config', join(import.meta.dirname, 'vite.config.ts'),
    join(import.meta.dirname, 'test/extensionVmProbe.ts'),
  ], {timeout: 10_000})
}, 15_000)
