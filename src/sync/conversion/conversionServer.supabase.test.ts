/**
 * The re-seal and its verify against a real stack: Supabase's Postgres image,
 * GoTrue and PostgREST, which `pnpm check:db` starts. The unit tests run the
 * engine against in-memory servers; this one shows how PostgREST reads the
 * adapter's filters and pages, and what `apply_block_patches` leaves in
 * `blocks_history` for the verify to find before the purge deletes it.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mintCanary } from '../crypto/canary.js'
import { ENVELOPE_PREFIX } from '../crypto/envelope.js'
import { SEALED_COLUMNS, type WireBlockColumns } from '../transform.js'
import { createSupabaseConversionServer, HISTORY_PAGE, IDS_PER_FILTER, type ContentColumns } from './conversionServer.js'
import { resealWorkspace } from './reseal.js'
import { contentColumnsOf, RESEAL_PAGE_SIZE } from './sealing.js'
import { keyOf, openRow } from './test/conversionFixtures.js'
import { verifyReseal } from './verifyReseal.js'

const stack = () => {
  const {CHECK_DB_DATABASE_URL: databaseUrl, CHECK_DB_AUTH_URL: authUrl, CHECK_DB_REST_URL: restUrl} = process.env
  if (!databaseUrl || !authUrl || !restUrl) throw new Error('this test needs the stack `pnpm check:db` starts; run it there')
  return {databaseUrl, authUrl, restUrl}
}

/** More rows than one page of the re-seal, so both passes page by id. */
const ROWS = RESEAL_PAGE_SIZE + 50
/** Rounds of decoy writes on each row of the first id chunk: enough that the
 *  chunk's matching history spans more than one page. */
const DECOY_ROUNDS = Math.floor(HISTORY_PAGE / IDS_PER_FILTER) + 1

const BLOCK_COLUMNS =
  'id, workspace_id, parent_id, order_key, content, properties_json, references_json, ' +
  'created_at, updated_at, user_updated_at, created_by, updated_by, deleted'
const WIRE_COLUMNS = 'id, workspace_id, content, properties_json, references_json'

/** A value that passes the re-seal's sealed test without being sealed. */
const lookalike = () => ENVELOPE_PREFIX + randomBytes(32).toString('base64url')

/** A new user, signed up through GoTrue, which here confirms the address without mail. */
const signUp = async (authUrl: string): Promise<{id: string; accessToken: string}> => {
  const response = await fetch(`${authUrl}/signup`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({email: `owner-${randomUUID()}@example.test`, password: randomUUID()}),
  })
  const body = await response.json()
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`sign-up failed (${response.status}): ${JSON.stringify(body)}`)
  }
  return {id: body.user.id, accessToken: body.access_token}
}

/** supabase-js addresses PostgREST under the gateway's `/rest/v1`. This stack
 *  has no gateway, so each request goes to PostgREST's root instead. */
const signedInClient = (restUrl: string, accessToken: string): SupabaseClient =>
  createClient(restUrl, 'no-gateway', {
    accessToken: async () => accessToken,
    global: {fetch: (input, init) => fetch(String(input).replace(`${restUrl}/rest/v1/`, `${restUrl}/`), init)},
  })

/** The flip, retried while the server finds writes in flight, as the design's
 *  flow does. Here that is most likely an autovacuum of the freshly seeded
 *  `blocks`, whose lock the flip's NOWAIT lock conflicts with. */
const flip = async (client: SupabaseClient, workspaceId: string, wk: CryptoKey) => {
  const canary = await mintCanary(wk, workspaceId)
  const error = await vi.waitFor(async () => {
    const {error} = await client.rpc('convert_workspace_to_e2ee', {p_workspace_id: workspaceId, p_wk_canary: canary})
    if (error?.code === '55P03') throw new Error(error.message)
    return error
  }, {timeout: 20_000, interval: 250})
  expect(error).toBeNull()
}

/** bigint columns (versions, event ids, counts) as numbers, as PostgREST returns them. */
const int8AsNumber = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === pg.types.builtins.INT8 ? Number : pg.types.getTypeParser(oid, format),
}

// The test takes about 5 s against a fresh stack.
describe('the re-seal and verify through PostgREST', {timeout: 60_000}, () => {
  const {databaseUrl, authUrl, restUrl} = stack()
  let db: pg.Client

  beforeAll(async () => {
    db = new pg.Client({connectionString: databaseUrl, types: int8AsNumber})
    await db.connect()
  })
  afterAll(() => db?.end())

  const query = async <Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await db.query<Row>(sql, params)).rows

  const insertWorkspace = async (workspaceId: string, ownerId: string, at: number) => {
    await query(
      `insert into public.workspaces (id, name, owner_user_id, create_time, update_time) values ($1, 'conversion', $2, $3, $3)`,
      [workspaceId, ownerId, at],
    )
    await query(
      `insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
       values (gen_random_uuid()::text, $1, $2, 'owner', $3)`,
      [workspaceId, ownerId, at],
    )
  }

  const insertRows = (workspaceId: string, ownerId: string, at: number, count: number) =>
    query(
      `insert into public.blocks (${BLOCK_COLUMNS})
       select gen_random_uuid()::text, $1, null, 'a' || n, 'note ' || n || ' · ünïcödé ✓',
              json_build_object('n', n)::text, json_build_array('ref-' || n)::text, $3, $3, $3, $2, $2, false
       from generate_series(1, $4::int) as n`,
      [workspaceId, ownerId, at, count],
    )

  /** Each row's content columns by id, in id order: the order PostgREST pages in. */
  const contentOf = async (workspaceId: string): Promise<Map<string, ContentColumns>> =>
    new Map(
      (await query<ContentColumns & {id: string}>(
        'select id, content, properties_json, references_json from public.blocks where workspace_id = $1 order by id',
        [workspaceId],
      )).map(row => [row.id, contentColumnsOf(row)]),
    )

  const rowsOf = (workspaceId: string) =>
    query('select * from public.blocks where workspace_id = $1 order by id', [workspaceId])

  const historyCount = async (workspaceId: string): Promise<number> =>
    (await query<{count: number}>('select count(*) from public.blocks_history where workspace_id = $1', [workspaceId]))[0]
      .count

  /** A plaintext workspace with history, returning its plaintext. */
  const seedPlaintextWorkspace = async (workspaceId: string, ownerId: string, at: number) => {
    await insertWorkspace(workspaceId, ownerId, at)
    await insertRows(workspaceId, ownerId, at, ROWS)
    // An empty value, a soft-deleted row, and a row two of whose columns
    // already pass the sealed test, which a plaintext workspace allows.
    await query(
      `insert into public.blocks (${BLOCK_COLUMNS}) values
         (gen_random_uuid()::text, $1, null, 'b1', '', '{}', '[]', $3, $3, $3, $2, $2, false),
         (gen_random_uuid()::text, $1, null, 'b2', 'deleted', '{}', '[]', $3, $3, $3, $2, $2, true),
         (gen_random_uuid()::text, $1, null, 'b3', $4, '{"plain":true}', $5, $3, $3, $3, $2, $2, false)`,
      [workspaceId, ownerId, at, lookalike(), lookalike()],
    )
    // Writes the history read's filter matches that aren't re-seal records:
    // their content only starts like an envelope.
    for (let round = 1; round <= DECOY_ROUNDS; round++) {
      await query(
        `update public.blocks
         set content = $2 || 'decoy ' || $3::int,
             properties_json = json_build_object('decoy', $3::int)::text,
             references_json = json_build_array($3::int)::text
         where id in (select id from public.blocks where workspace_id = $1 order by id limit $4)`,
        [workspaceId, ENVELOPE_PREFIX, round, IDS_PER_FILTER],
      )
    }
    // Writes the filter must leave out: an envelope-shaped value in content
    // alone, and all three columns with content in the wrong case.
    await query(
      `update public.blocks set content = $2
       where id = (select id from public.blocks where workspace_id = $1 order by id desc limit 1)`,
      [workspaceId, lookalike()],
    )
    await query(
      `update public.blocks
       set content = 'ENC:V1:wrong case', properties_json = '{"edited":true}', references_json = '["edited"]'
       where id = (select id from public.blocks where workspace_id = $1 order by id desc offset 1 limit 1)`,
      [workspaceId],
    )
    return contentOf(workspaceId)
  }

  /** One write with triggers off: it adds no history row and no new version. */
  const writeWithoutTriggers = async (sql: string, params: unknown[]) => {
    await query('begin')
    await query('set local session_replication_role = replica')
    await query(sql, params)
    await query('commit')
  }

  it('seals every row, finds each re-seal record, repairs a tampered row, and leaves history the purge accepts', async () => {
    const owner = await signUp(authUrl)
    const client = signedInClient(restUrl, owner.accessToken)
    const server = createSupabaseConversionServer(client)
    const wk = await keyOf(7)
    const ws = randomUUID()
    // Another workspace of the same owner, which RLS shows to the same session.
    const otherWs = randomUUID()
    // A minute back, so the clamp trigger leaves the seeded versions alone.
    const at = Date.now() - 60_000

    const plaintext = await seedPlaintextWorkspace(ws, owner.id, at)
    const total = plaintext.size
    const ids = [...plaintext.keys()]
    await insertWorkspace(otherWs, owner.id, at)
    await insertRows(otherWs, owner.id, at, 3)
    const otherRows = await rowsOf(otherWs)

    await flip(client, ws, wk)
    // The recovery bundle's archive point, read as the flow reads it right after the flip.
    const [bundle] = await query<{through: number; archived: number}>(
      'select coalesce(max(event_id), 0) as through, count(*) as archived from public.blocks_history where workspace_id = $1',
      [ws],
    )

    // ── re-seal ──
    expect(await resealWorkspace({server, workspaceId: ws, wk})).toEqual({scanned: total, sealed: total})

    const [{unsealed}] = await query<{unsealed: number}>(
      `select count(*) as unsealed from public.blocks
       where workspace_id = $1 and not public.is_sealed_block(content, properties_json, references_json)`,
      [ws],
    )
    expect(unsealed).toBe(0)

    // One write per row, each recording the row's whole plaintext in before_diff.
    const resealWrites = await query<{block_id: string; before_diff: ContentColumns}>(
      'select block_id, before_diff from public.blocks_history where workspace_id = $1 and event_id > $2',
      [ws, bundle.through],
    )
    expect(resealWrites).toHaveLength(total)
    expect(new Map(resealWrites.map(write => [write.block_id, contentColumnsOf(write.before_diff)]))).toEqual(plaintext)

    // The adapter's history read returns exactly what its filter selects from
    // the whole history, across pages and id chunks.
    const history = await query<{event_id: number; block_id: string; op: string; changed_columns: string[] | null; content: string | null}>(
      `select event_id, block_id, op, changed_columns, after_diff ->> 'content' as content
       from public.blocks_history where workspace_id = $1`,
      [ws],
    )
    const selected = history.filter(row =>
      row.op === 'U' &&
      SEALED_COLUMNS.every(column => row.changed_columns?.includes(column)) &&
      row.content?.startsWith(ENVELOPE_PREFIX))
    expect(selected).toHaveLength(IDS_PER_FILTER * DECOY_ROUNDS + total)
    const firstChunk = new Set(ids.slice(0, IDS_PER_FILTER))
    expect(selected.filter(row => firstChunk.has(row.block_id)).length).toBeGreaterThan(HISTORY_PAGE)
    const read = await server.readContentSealHistory(ws, ids)
    const byEvent = (a: number, b: number) => a - b
    expect(read.map(row => row.event_id).sort(byEvent)).toEqual(selected.map(row => row.event_id).sort(byEvent))

    // ── tamper ──
    // Another row's sealed content, so the row differs from its record at the
    // version the record wrote: the one difference verify repairs. The row is
    // in the first chunk, whose records sit on the second page of its history.
    const [tampered, donor] = ids
    const [before] = await query<{updated_at: number}>('select updated_at from public.blocks where id = $1', [tampered])
    const historyBefore = await historyCount(ws)
    await writeWithoutTriggers(
      'update public.blocks set content = (select content from public.blocks where id = $2) where id = $1',
      [tampered, donor],
    )
    const [after] = await query<WireBlockColumns & {updated_at: number}>(
      `select ${WIRE_COLUMNS}, updated_at from public.blocks where id = $1`,
      [tampered],
    )
    expect(after.updated_at).toBe(before.updated_at)
    expect(await historyCount(ws)).toBe(historyBefore)
    await expect(openRow(wk, after)).rejects.toThrow()

    // ── verify ──
    expect(await verifyReseal({server, workspaceId: ws, wk})).toEqual({checked: total, repaired: 1})
    expect(await verifyReseal({server, workspaceId: ws, wk})).toEqual({checked: total, repaired: 0})

    const sealedRows = await query<WireBlockColumns>(`select ${WIRE_COLUMNS} from public.blocks where workspace_id = $1`, [ws])
    const opened = new Map(await Promise.all(sealedRows.map(async row => [row.id, await openRow(wk, row)] as const)))
    expect(opened).toEqual(plaintext)
    expect(await rowsOf(otherWs)).toEqual(otherRows)

    // ── the purge takes the engine's writes as re-seal writes ──
    const {error: purgeError} = await client.rpc('purge_workspace_history', {
      p_workspace_id: ws,
      p_through_event_id: bundle.through,
      p_archived_count: bundle.archived,
    })
    expect(purgeError).toBeNull()
    expect(await historyCount(ws)).toBe(0)
    expect(await query('select phase from public.workspace_conversions where workspace_id = $1', [ws]))
      .toEqual([{phase: 'cleaning'}])
  })
})
