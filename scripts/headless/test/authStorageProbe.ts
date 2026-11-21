import assert from 'node:assert/strict'
import {setAuthStorage} from '@/services/authStorage'

const step = process.argv.at(-1)
assert.ok(step === 'refresh' || step === 'restore')
const restore = step === 'restore'
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'https://test.invalid/auth/v1/token?grant_type=refresh_token')
  assert.deepEqual(JSON.parse(String(init?.body)), {refresh_token: restore ? 'rotated' : 'original'})
  return restore
    ? Response.json({error: 'invalid_grant', message: 'Refresh token revoked'}, {status: 400})
    : Response.json({
        access_token: 'test-access', refresh_token: 'rotated',
        token_type: 'bearer', expires_in: 3600, user: {id: 'member'},
      })
}

setAuthStorage(localStorage)
const {supabase} = await import('@/services/supabase')
assert.ok(supabase)
const auth = supabase.auth
await auth.stopAutoRefresh()

if (restore) {
  const session = (await auth.getSession()).data.session
  assert.equal(session?.refresh_token, 'rotated')
  let signedOut = 0
  auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') signedOut++ })
  assert.equal((await auth.refreshSession()).error?.status, 400)
  assert.equal(signedOut, 0)
  assert.equal((await auth.getSession()).data.session?.refresh_token, 'rotated')

  // After expiry a permanently refused refresh removes the persisted session.
  const afterExpiry = (session.expires_at! + 1) * 1000
  Date.now = () => afterExpiry
  assert.equal((await auth.getSession()).error?.status, 400)
  assert.equal(signedOut, 1)
  assert.equal((await auth.getSession()).data.session, null)
} else {
  assert.equal((await auth.getSession()).data.session, null)
  const result = await auth.refreshSession({refresh_token: 'original'})
  assert.equal(result.error, null)
  assert.equal(result.data.session?.refresh_token, 'rotated')
}

console.log(step)
