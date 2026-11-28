import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import type {PowerSyncDatabase} from '@powersync/node'

// NODE_OPTIONS loads this in both the launcher and its vite-node replacement.
// Only the replacement has the file-backed Storage used by the host.
if (process.execArgv.some(arg => arg.startsWith('--localstorage-file='))) {
  const {PowerSyncDatabase: Database} = await import('@powersync/node')
  localStorage.setItem('sb-auth-auth-token', JSON.stringify({
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: {id: 'member'},
  }))
  const fetchBridge = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === 'https://auth.invalid/auth/v1/token?grant_type=refresh_token') {
      return Response.json({
        access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        token_type: 'bearer', expires_in: 3600, user: {id: 'member'},
      })
    }
    if (url.href === 'https://cdn.invalid/fixture.mjs' && process.env.HEADLESS_TEST_CDN) {
      return fetchBridge(process.env.HEADLESS_TEST_CDN, init)
    }
    if (url.origin === 'https://matrix.invalid' && process.env.HEADLESS_TEST_MATRIX) {
      const local = new URL(url.pathname + url.search, process.env.HEADLESS_TEST_MATRIX)
      return fetchBridge(input instanceof Request ? new Request(local, input) : local, init)
    }
    assert.equal(url.origin, process.env.AGENT_RUNTIME_URL)
    return fetchBridge(input, init)
  }

  // Stand in for a downloaded checkpoint. The launcher, auth/session
  // storage, database, Repo, command context and bridge are all real.
  Database.prototype.connect = async function (this: PowerSyncDatabase) {
    assert.equal(typeof document, 'undefined')
    assert.equal(window.localStorage, localStorage)
    assert.equal(process.env.NODE_ENV, 'production')
    const react = createRequire(import.meta.url)('react') as typeof import('react')
    assert.equal(react.act, undefined, 'React must select its production build')
    await this.execute(`INSERT OR IGNORE INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES ('fixture', 'test', ?, 1, 1, 'none', 'children')`, [process.env.HEADLESS_TEST_OWNER ?? 'member'])
    await this.execute(`INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role, create_time)
      VALUES ('membership', 'fixture', 'member', ?, 1)`, [process.env.HEADLESS_TEST_ROLE ?? 'viewer'])
    const testStatements = async (file: string) => {
      const statements = JSON.parse(await readFile(file, 'utf8')) as Array<[string, unknown[]]>
      await this.writeTransaction(async tx => {
        for (const [sql, parameters] of statements) await tx.execute(sql, parameters)
      })
    }
    if (process.env.HEADLESS_TEST_INITIAL) {
      await testStatements(process.env.HEADLESS_TEST_INITIAL)
    }
    const changes = process.env.HEADLESS_TEST_CHANGES
    if (changes) {
      process.on('SIGUSR2', () => { void testStatements(changes).catch(error => { throw error }) })
    }
    Object.defineProperties(this.currentStatus, {
      connected: {value: true, configurable: true},
      lastSyncedAt: {value: new Date(), configurable: true},
    })
  }
}
