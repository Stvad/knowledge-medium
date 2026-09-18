import {EventEmitter} from 'node:events'
import {describe, expect, it} from 'vitest'
import {runJsonlProcess, type SpawnImpl} from '../src/execProcess'

/** A spawn that fails the way node does when it cannot start a child. */
const spawnFailing = (code: string, message: string): SpawnImpl => (() => {
  const child = new EventEmitter() as unknown as ReturnType<SpawnImpl>
  Object.assign(child, {stdin: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true})
  queueMicrotask(() => child.emit('error', Object.assign(new Error(message), {code})))
  return child
}) as unknown as SpawnImpl

const run = (cwd: string, spawnImpl: SpawnImpl) => runJsonlProcess({
  bin: 'claude', args: [], prompt: 'x', timeoutMs: 1_000, cwd, spawnImpl,
  onStdoutText: () => {},
})

describe('spawn failures name their own cause', () => {
  it('reports a missing working directory as such, not as a missing binary', async () => {
    // Node raises the same ENOENT for both, and they want opposite handling:
    // a binary off launchd's PATH is the transient this daemon defers, while
    // a cwd that does not exist fails identically forever — and deferring it
    // cools the shared executor lane for watchers whose directories are fine.
    await expect(run('/definitely/not/a/real/directory', spawnFailing('ENOENT', 'spawn claude ENOENT')))
      .rejects.toThrow(/working directory does not exist/)
  })

  it('leaves a genuine missing binary reported as the spawn error it is', async () => {
    // cwd exists here, so the ENOENT is about the executable.
    await expect(run(process.cwd(), spawnFailing('ENOENT', 'spawn claude ENOENT')))
      .rejects.toThrow(/spawn claude ENOENT/)
  })

  it('passes other spawn errors through untouched', async () => {
    await expect(run('/definitely/not/a/real/directory', spawnFailing('EACCES', 'spawn claude EACCES')))
      .rejects.toThrow(/EACCES/)
  })
})
