import {execFile, type ExecFileException} from 'node:child_process'
import {open} from 'node:fs/promises'
import type {KeySource} from './config'

const KEY_COMMAND_TIMEOUT_MS = 15_000

/** The `kmp-wk-1:` string, for the unlock flow, which zeroes its parsed copy. */
export const readWorkspaceKey = (source: KeySource, timeoutMs = KEY_COMMAND_TIMEOUT_MS): Promise<string> =>
  source.keyFile !== undefined ? readKeyFile(source.keyFile) : runKeyCommand(source.keyCommand, timeoutMs)

async function readKeyFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    if (((await handle.stat()).mode & 0o777) !== 0o600) throw new Error('Key file must have mode 0600')
    return (await handle.readFile('utf8')).trim()
  } finally {
    await handle.close()
  }
}

/** Errors name argv[0] and how it ended, never its output: stdout is the key,
 *  and stderr of a secret store may echo it. */
async function runKeyCommand([program, ...args]: readonly string[], timeoutMs: number): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(program, args, {
      timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (error, out) => error
      ? reject(new Error(`Key command ${program} ${describeFailure(error, timeoutMs)}`))
      : resolve(out))
  })
  const key = stdout.trim()
  if (!key) throw new Error(`Key command ${program} printed no key`)
  return key
}

function describeFailure(error: ExecFileException, timeoutMs: number): string {
  if (error.killed) return `timed out after ${timeoutMs}ms`
  if (typeof error.code === 'number') return `exited with status ${error.code}`
  if (error.signal) return `was killed by ${error.signal}`
  return `could not run (${error.code ?? 'unknown error'})`
}
