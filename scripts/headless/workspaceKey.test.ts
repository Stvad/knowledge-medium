import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {readWorkspaceKey} from './workspaceKey'

const key = 'kmp-wk-1:synthetic-test-key'
const leak = 'synthetic-stderr-secret'
let dir: string
const script = async (name: string, body: string) => {
  const file = join(dir, `${name}.mjs`)
  await writeFile(file, body)
  return [process.execPath, file] as [string, string]
}
const fromCommand = (keyCommand: [string, ...string[]], timeoutMs?: number) =>
  readWorkspaceKey({keyCommand}, timeoutMs)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'headless-key-'))
})
afterAll(async () => {
  await rm(dir, {recursive: true, force: true})
})

describe('workspace key from a file', () => {
  it('reads the key, trimmed', async () => {
    const keyFile = join(dir, 'device.key')
    await writeFile(keyFile, `${key}\n`, {mode: 0o600})
    await expect(readWorkspaceKey({keyFile})).resolves.toBe(key)
  })

  it('refuses a group-readable key file', async () => {
    const keyFile = join(dir, 'shared.key')
    await writeFile(keyFile, key, {mode: 0o600})
    await chmod(keyFile, 0o640)
    await expect(readWorkspaceKey({keyFile})).rejects.toThrow('0600')
  })
})

describe('workspace key from a command', () => {
  it('reads the command stdout, trimmed', async () => {
    const command = await script('prints', `process.stdout.write(${JSON.stringify(`  ${key}\n`)})`)
    await expect(fromCommand(command)).resolves.toBe(key)
  })

  it('names the command and its exit status, never its output', async () => {
    const command = await script('fails', [
      `process.stdout.write(${JSON.stringify(key)})`,
      `process.stderr.write(${JSON.stringify(leak)})`,
      'process.exitCode = 3',
    ].join('\n'))
    const error: Error = await fromCommand(command).catch(e => e)
    expect(error.message).toBe(`Key command ${process.execPath} exited with status 3`)
  })

  it('kills a command that outlives the timeout', async () => {
    const command = await script('hangs', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
    await expect(fromCommand(command, 200)).rejects.toThrow(`Key command ${process.execPath} timed out after 200ms`)
  })

  it('names the signal that killed a command', async () => {
    const command = await script('killed', `process.kill(process.pid, 'SIGKILL')`)
    await expect(fromCommand(command)).rejects.toThrow(`Key command ${process.execPath} was killed by SIGKILL`)
  })

  it('refuses a command that prints no key', async () => {
    const command = await script('silent', `process.stdout.write(' \\n')`)
    await expect(fromCommand(command)).rejects.toThrow(`Key command ${process.execPath} printed no key`)
  })

  it('names a command that cannot start', async () => {
    const missing = join(dir, 'no-such-command')
    await expect(fromCommand([missing])).rejects.toThrow(`Key command ${missing} could not run (ENOENT)`)
  })
})
