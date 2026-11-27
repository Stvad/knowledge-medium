import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {PowerSyncDatabase} from '@powersync/node'

// NODE_OPTIONS loads this in both the launcher and its vite-node replacement.
// Only the replacement has the file-backed Storage used by the host.
if (process.execArgv.some(arg => arg.startsWith('--localstorage-file='))) {
  localStorage.setItem('sb-auth-auth-token', JSON.stringify({
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: {id: 'member'},
  }))
  const fetchBridge = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input) === 'https://auth.invalid/auth/v1/token?grant_type=refresh_token') {
      return Response.json({
        access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        token_type: 'bearer', expires_in: 3600, user: {id: 'member'},
      })
    }
    assert.equal(new URL(String(input)).origin, process.env.AGENT_RUNTIME_URL)
    return fetchBridge(input, init)
  }

  // Stand in for a downloaded checkpoint. The launcher, auth/session
  // storage, database, Repo, command context and bridge are all real.
  PowerSyncDatabase.prototype.connect = async function (this: PowerSyncDatabase) {
    assert.equal(typeof document, 'undefined')
    assert.equal(window.localStorage, localStorage)
    assert.equal(process.env.NODE_ENV, 'production')
    const react = createRequire(import.meta.url)('react') as typeof import('react')
    assert.equal(react.act, undefined, 'React must select its production build')
    await this.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES ('fixture', 'test', 'member', 1, 1, 'none', 'children')`)
    await this.execute(`INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time)
      VALUES ('membership', 'fixture', 'member', 'viewer', 1)`)
    Object.defineProperties(this.currentStatus, {
      connected: {value: true, configurable: true},
      lastSyncedAt: {value: new Date(), configurable: true},
    })
  }
}
