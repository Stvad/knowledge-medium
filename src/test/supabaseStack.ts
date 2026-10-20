/**
 * The stack `pnpm check:db` starts for `*.supabase.test.ts`: Supabase's
 * Postgres image, GoTrue, PostgREST and the Storage API, each on its own port
 * with no gateway in front. `pnpm check:db --hold` keeps one up and prints the
 * addresses {@link supabaseStack} reads.
 */

import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseStack {
  /** Postgres as its superuser, which RLS doesn't filter. */
  readonly databaseUrl: string
  readonly authUrl: string
  /** PostgREST's root, no `/rest/v1`. */
  readonly restUrl: string
  /** The Storage API's root, no `/storage/v1`. */
  readonly storageUrl: string
  readonly anonKey: string
  /** The stack's privileged key, which RLS doesn't filter. Minted per run, never a project's. */
  readonly serviceKey: string
}

export const supabaseStack = (): SupabaseStack => {
  const env = process.env
  const stack = {
    databaseUrl: env.CHECK_DB_DATABASE_URL,
    authUrl: env.CHECK_DB_AUTH_URL,
    restUrl: env.CHECK_DB_REST_URL,
    storageUrl: env.CHECK_DB_STORAGE_URL,
    anonKey: env.CHECK_DB_ANON_KEY,
    serviceKey: env.CHECK_DB_SERVICE_KEY,
  }
  if (Object.values(stack).some(value => !value)) {
    throw new Error('this test needs the stack `pnpm check:db` starts; run it there')
  }
  return stack as SupabaseStack
}

/** The origin supabase-js is given. Nothing serves it: {@link stackClient}
 *  routes each request by its path, as a project's gateway does. */
const GATEWAY = 'http://gateway.check-db.invalid'

/**
 * A supabase-js client over the stack, holding `key` as its API key and no
 * session until it signs in. Its requests go straight to the server the
 * gateway would route them to.
 */
export const stackClient = (stack: SupabaseStack, key = stack.anonKey): SupabaseClient => {
  const routes = [
    [`${GATEWAY}/auth/v1`, stack.authUrl],
    [`${GATEWAY}/rest/v1`, stack.restUrl],
    [`${GATEWAY}/storage/v1`, stack.storageUrl],
  ] as const
  const routed: typeof fetch = (input, init) => {
    const url = String(input)
    const route = routes.find(([from]) => url.startsWith(`${from}/`) || url.startsWith(`${from}?`))
    if (!route) throw new Error(`no stack server serves ${url}`)
    return fetch(route[1] + url.slice(route[0].length), init)
  }
  return createClient(GATEWAY, key, {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
    global: {fetch: routed},
  })
}

export interface StackUser {
  readonly id: string
  /** Signed in as this user. */
  readonly client: SupabaseClient
}

/** A new user, signed up through GoTrue, which here confirms the address without mail. */
export const signedInUser = async (stack: SupabaseStack): Promise<StackUser> => {
  const client = stackClient(stack)
  const {data, error} = await client.auth.signUp({email: `user-${randomUUID()}@example.test`, password: randomUUID()})
  if (error || !data.user || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return {id: data.user.id, client}
}
