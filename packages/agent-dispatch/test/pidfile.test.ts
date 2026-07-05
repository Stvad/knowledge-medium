import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {acquirePidfile, releasePidfile} from '../src/pidfile'

let dir: string
let file: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-pid-'))
  file = path.join(dir, 'daemon.pid')
})
afterAll(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})
beforeEach(async () => {
  await fs.rm(file, {force: true})
  await fs.rm(`${file}.takeover`, {recursive: true, force: true})
})

const DEAD_PID = 999_999
const alive = (pid: number) => pid !== DEAD_PID

describe('acquirePidfile', () => {
  it('creates the pidfile and release removes only its own', async () => {
    await acquirePidfile({file, pid: 111, isAlive: alive})
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')

    await releasePidfile({file, pid: 222}) // not ours — must stay
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')
    await releasePidfile({file, pid: 111})
    await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({code: 'ENOENT'})
  })

  it('refuses when a live daemon holds the pidfile', async () => {
    await fs.writeFile(file, '111\n')
    await expect(acquirePidfile({file, pid: 222, isAlive: alive})).rejects.toThrow(/already running/)
  })

  it('takes over a stale pidfile', async () => {
    await fs.writeFile(file, `${DEAD_PID}\n`)
    await acquirePidfile({file, pid: 111, isAlive: alive})
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('111')
  })

  it('two concurrent stale takeovers admit exactly ONE daemon', async () => {
    await fs.writeFile(file, `${DEAD_PID}\n`)
    // Both contenders read the same dead pid; without an atomic gate the
    // loser's rm can land on the winner's FRESH pidfile and both acquire.
    const results = await Promise.allSettled([
      acquirePidfile({file, pid: 111, isAlive: alive}),
      acquirePidfile({file, pid: 222, isAlive: alive}),
    ])
    const winners = results.filter(result => result.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    const holder = (await fs.readFile(file, 'utf8')).trim()
    expect(['111', '222']).toContain(holder)
  })
})
