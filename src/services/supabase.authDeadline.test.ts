import { afterEach, describe, expect, it, vi } from 'vitest'

// The app's REAL client (supabase.test.ts mocks createClient on purpose), so
// this proves auth-js sends its requests through our fetch, not its own.
describe('app Supabase client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('sends Auth requests with a deadline signal', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    const requests: Array<{url: string; signal: AbortSignal | null | undefined}> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({url: String(input), signal: init?.signal})
      return new Response(JSON.stringify({error: 'invalid_grant'}), {status: 400})
    }))
    vi.resetModules()
    const {supabase} = await import('@/services/supabase')

    await supabase!.auth.refreshSession({refresh_token: 'refresh-token'})

    const refresh = requests.find(r => r.url.includes('/auth/v1/token'))
    expect(refresh?.signal).toBeInstanceOf(AbortSignal)
  })
})
