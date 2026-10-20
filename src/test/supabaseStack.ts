/**
 * The stack `pnpm check:db` starts for `*.supabase.test.ts`: Supabase's
 * Postgres image, GoTrue, PostgREST and the Storage API, each on its own port
 * with no gateway in front. `pnpm check:db --hold` keeps one up and prints the
 * addresses {@link supabaseStack} reads.
 */

import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'

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

/** Stands between a client and the stack: `send` forwards the request, and a
 *  tap may act before it, hold it, or fail it instead. */
export type StackTap = (url: URL, init: RequestInit | undefined, send: () => Promise<Response>) => Promise<Response>

/**
 * A supabase-js client over the stack, holding `key` as its API key and no
 * session until it signs in. Its requests go straight to the server the
 * gateway would route them to, through `tap` when one is given.
 */
export const stackClient = (stack: SupabaseStack, key = stack.anonKey, tap?: StackTap): SupabaseClient => {
  const routes = [
    [`${GATEWAY}/auth/v1`, stack.authUrl],
    [`${GATEWAY}/rest/v1`, stack.restUrl],
    [`${GATEWAY}/storage/v1`, stack.storageUrl],
  ] as const
  const routed: typeof fetch = (input, init) => {
    const url = String(input)
    const route = routes.find(([from]) => url.startsWith(`${from}/`) || url.startsWith(`${from}?`))
    if (!route) throw new Error(`no stack server serves ${url}`)
    const send = () => fetch(route[1] + url.slice(route[0].length), init)
    return tap ? tap(new URL(url), init, send) : send()
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
export const signedInUser = async (stack: SupabaseStack, tap?: StackTap): Promise<StackUser> => {
  const client = stackClient(stack, stack.anonKey, tap)
  const {data, error} = await client.auth.signUp({email: `user-${randomUUID()}@example.test`, password: randomUUID()})
  if (error || !data.user || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return {id: data.user.id, client}
}

/** The stack's Postgres as its superuser, which RLS doesn't filter, with
 *  bigint columns (versions, event ids, counts) read as numbers, as PostgREST
 *  returns them. */
export interface StackDb {
  query<Row extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<Row[]>
  /** One write with triggers off: no history row, no new version, no check. */
  writeWithoutTriggers(sql: string, params: unknown[]): Promise<void>
  /** A workspace and its members, the first of them its owner. */
  insertWorkspace(workspace: {
    readonly id: string
    readonly name: string
    readonly at: number
    readonly members: ReadonlyArray<readonly [userId: string, role: 'owner' | 'editor' | 'viewer']>
    readonly e2ee?: {readonly canary: string}
  }): Promise<void>
  end(): Promise<void>
}

const int8AsNumber = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === pg.types.builtins.INT8 ? Number : pg.types.getTypeParser(oid, format),
}

export const connectStackDb = async (stack: SupabaseStack): Promise<StackDb> => {
  const client = new pg.Client({connectionString: stack.databaseUrl, types: int8AsNumber})
  await client.connect()
  const query = async <Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await client.query<Row>(sql, params)).rows
  return {
    query,
    async writeWithoutTriggers(sql, params) {
      await query('begin')
      await query('set local session_replication_role = replica')
      await query(sql, params)
      await query('commit')
    },
    async insertWorkspace({id, name, at, members, e2ee}) {
      await query(
        `insert into public.workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary)
         values ($1, $2, $3, $4, $4, $5, $6)`,
        [id, name, members[0][0], at, e2ee ? 'e2ee' : 'none', e2ee?.canary ?? null],
      )
      for (const [userId, role] of members) {
        await query(
          `insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
           values (gen_random_uuid()::text, $1, $2, $3, $4)`,
          [id, userId, role, at],
        )
      }
    },
    end: () => client.end(),
  }
}
