// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireWorkspaceLock } from './workspaceLock'

const lockFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-lock-')), 'workspace.lock')
const heldPid = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as {pid: number}).pid

describe('acquireWorkspaceLock', () => {
  it('refuses a second acquire while held and allows it after release', () => {
    const file = lockFile()
    const release = acquireWorkspaceLock(file)
    expect(() => acquireWorkspaceLock(file)).toThrow(`pid ${process.pid}`)
    release()
    acquireWorkspaceLock(file)()
  })

  it('takes over a lock left by a dead process', () => {
    const file = lockFile()
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(file, JSON.stringify({pid: deadPid, since: 'x'}))
    acquireWorkspaceLock(file)
    expect(heldPid(file)).toBe(process.pid)
  })

  it('does not remove a lock someone else holds on release', () => {
    const file = lockFile()
    const release = acquireWorkspaceLock(file)
    writeFileSync(file, JSON.stringify({pid: process.pid + 1, since: 'x'}))
    release()
    expect(existsSync(file)).toBe(true)
  })

  it('takes over an unparseable lock file', () => {
    const file = lockFile()
    writeFileSync(file, 'not json')
    acquireWorkspaceLock(file)
    expect(heldPid(file)).toBe(process.pid)
  })
})
