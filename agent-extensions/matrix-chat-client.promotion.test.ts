// @vitest-environment happy-dom
//
// Drives the REAL matrix ingest — the extension's own poll effect, its own
// promotion, its own write — against a CHILD-BACKED workspace, because that is
// the only configuration in which the hazard exists.
//
// What it pins (#594): a `key:: value` in a message whose key already has a
// definition too narrow to hold the text used to abort the writing
// transaction, via the materialize processor's rejection. Ingest holds its
// sync cursor on a failed write on purpose (Matrix offers an event once), so
// that abort meant the same event was retried forever and ingest stopped for
// good. The guard declines that one key at promotion instead.
//
// The assertions are on VALUES, never counts, and the mixed case is the point:
// one message carries a key that cannot be stored and a key that can, so a
// blanket refusal fails this as loudly as no refusal at all.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The extension imports the matrix SDK from a URL, which no test runner can
// fetch. Only two of its methods are on the ingest path.
//
// The stub answers BY CURSOR, the way a homeserver does, and that is what
// makes a stall observable: a client that does not advance its cursor is
// handed the same events again, forever. An earlier version of this file
// returned a queue of bodies regardless of `since` — under which the
// "ingest keeps going" test passed with the guard deleted, because the failing
// message was silently replaced by the next one instead of being re-delivered.
const timeline = new Map<string, unknown>()
vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({
  createClient: () => ({
    mxcUrlToHttp: (url: string) => url,
    http: {
      authedRequest: (
        _method: string,
        _path: string,
        query: {since?: string},
        _body: unknown,
        opts: {abortSignal?: AbortSignal},
      ) => {
        const body = query.since === undefined ? undefined : timeline.get(query.since)
        if (body !== undefined) return Promise.resolve(body)
        // Nothing to deliver from this position: behave like a long poll that
        // only ends when the caller aborts, rather than spinning the loop.
        return new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {once: true},
          )
        })
      },
    },
  }),
}))

import type { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import type { AppExtension } from '@/facets/facet.js'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage.js'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi.js'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'

import matrixContributions from './matrix-chat-client.tsx'

const WS = 'ws-matrix'
const HOMESERVER = 'https://matrix.test'
const ROOM = '!room:matrix.test'
const TOKEN_KEY = 'knowledge-medium:matrix:token:v1'
const NEXT_BATCH_KEY = `knowledge-medium:matrix-messages:state:v1:${HOMESERVER}:${ROOM}`

/** The app shell owns mounts and effects; a repo-level runtime takes neither.
 *  The effect object itself is pulled out separately and started by hand —
 *  `effect.start({repo})` is exactly what `liveRuntime` calls. */
const contributions = matrixContributions as unknown as Array<{
  facet?: {id: string}
  value?: unknown
}>
const matrixDataExtensions = contributions
  .filter(c => 'facet' in c && c.facet?.id !== 'core.app-mounts' && c.facet?.id !== 'core.app-effects')
  .map(c => c as unknown) as unknown as AppExtension[]
const ingestEffect = contributions
  .find(c => c.facet?.id === 'core.app-effects')!.value as {
    start: (ctx: {repo: Repo}) => (() => void) | void
  }

let sharedDb: TestDb
let stopIngest: (() => void) | void

/** A child-backed workspace: `properties_migration = 'children'` is the flip,
 *  and it is what makes the materialize processor run at all. */
const seedFlippedWorkspace = async (): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'ws', 'user-1'],
  )
}

const setup = async (): Promise<Repo> => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      dailyNotesDataExtension,
      ...matrixDataExtensions,
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  return repo
}

/** Configure the extension the way the setup dialog would, and pre-seed the
 *  cursor: ingest deliberately ignores the events of a cursor-less first sync
 *  (that call only establishes a position), so without one no message is ever
 *  read. */
const contributionValue = (facetId: string, match: (value: any) => boolean): any =>
  contributions.find(c => c.facet?.id === facetId && match(c.value))!.value

const configureIngest = async (repo: Repo): Promise<void> => {
  window.localStorage.setItem(TOKEN_KEY, 'secret-token')
  window.localStorage.setItem(
    NEXT_BATCH_KEY,
    JSON.stringify({nextBatch: 'cursor-0', savedAt: 1}),
  )
  const prefsType = contributionValue('data.type-seeds', v => v?.id === 'matrix-chat-prefs')
  const seed = (name: string) =>
    contributionValue('data.definition-seeds', v => v?.name === name)
  const block = await getPluginPrefsBlock(repo, WS, repo.user, prefsType)
  await block.set(seed('matrix:homeserver'), HOMESERVER)
  await block.set(seed('matrix:roomId'), ROOM)
  await block.set(seed('matrix:autoStart'), true)
}

const messageEvent = (eventId: string, body: string) => ({
  type: 'm.room.message',
  event_id: eventId,
  sender: '@someone:matrix.test',
  origin_server_ts: 1_700_000_000_000,
  content: {msgtype: 'm.text', body},
})

const syncBody = (nextBatch: string, events: unknown[]) => ({
  next_batch: nextBatch,
  rooms: {join: {[ROOM]: {timeline: {events}}}},
})

interface Row {id: string; content: string; parent_id: string | null; properties_json: string}
const rowByContent = async (content: string): Promise<Row | undefined> =>
  (await sharedDb.db.getAll<Row>(
    'SELECT id, content, parent_id, properties_json FROM blocks WHERE deleted = 0 AND content = ?',
    [content],
  ))[0]

const childContents = async (parentId: string): Promise<string[]> =>
  (await sharedDb.db.getAll<{content: string}>(
    'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )).map(r => r.content)

const cellBag = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

const savedCursor = (): string | null => {
  const raw = window.localStorage.getItem(NEXT_BATCH_KEY)
  return raw ? (JSON.parse(raw) as {nextBatch: string}).nextBatch : null
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  timeline.clear()
  window.localStorage.clear()
  await resetTestDb(sharedDb.db)
  await seedFlippedWorkspace()
})
afterEach(() => {
  stopIngest?.()
  stopIngest = undefined
})

describe('matrix ingest into a child-backed workspace', () => {
  // Both tests settle in ~150ms each when the guard holds. The budget is sized
  // for the FAILING shape instead: a rejected write backs the poll off 5s
  // before retrying, so a regression has to be given room to be observed
  // rather than reported as a bare timeout.
  it(
    'withholds a key its definition cannot hold, keeps the bullet, and advances the cursor',
    async () => {
      const repo = await setup()
      // A definition narrower than message text can be — the shape a user
      // creates by hand, or that inference lands on from earlier numeric
      // values. Nothing about "many" can be reshaped into a number.
      await repo.userSchemas.addSchema({name: 'matrix:count', presetId: 'number'})
      await configureIngest(repo)

      timeline.set('cursor-0', syncBody('cursor-1', [
        messageEvent('$evt-1', '- hello\n  - count:: many\n  - note:: from the room'),
      ]))

      stopIngest = ingestEffect.start({repo})

      const message = await vi.waitFor(async () => {
        const row = await rowByContent('hello')
        expect(row, 'the message never landed').toBeDefined()
        return row!
      }, {timeout: 10_000, interval: 50})

      // Precondition, asserted rather than assumed: the workspace really is
      // child-backed and the materialize processor really ran, so a pass here
      // cannot be "the hazard was never reached".
      const materialized = await sharedDb.db.getAll<{content: string}>(
        'SELECT content FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0',
        [message.id],
      )
      expect(materialized.length, 'no property children — the workspace is not child-backed')
        .toBeGreaterThan(0)

      const bag = await cellBag(message.id)
      // The unstorable key was withheld…
      expect(bag['matrix:count']).toBeUndefined()
      // …and its text survives verbatim, as the bullet the user wrote.
      expect(await childContents(message.id)).toContain('count:: many')
      // The storable key on the SAME message is unaffected: promoted onto the
      // parent, and its bullet subtracted.
      expect(bag['matrix:note']).toBe('from the room')
      expect(await childContents(message.id)).not.toContain('note:: from the room')

      // The write committed, so the cursor moved on. Holding at 'cursor-0' is
      // the stall: the same event would be re-delivered forever.
      await vi.waitFor(() => { expect(savedCursor()).toBe('cursor-1') }, {timeout: 10_000, interval: 50})
    },
    30_000,
  )

  it('keeps ingesting the next message after one carried an unstorable key', async () => {
    const repo = await setup()
    await repo.userSchemas.addSchema({name: 'matrix:count', presetId: 'number'})
    await configureIngest(repo)

    timeline.set('cursor-0', syncBody('cursor-1', [
      messageEvent('$evt-1', '- first\n  - count:: many'),
    ]))
    timeline.set('cursor-1', syncBody('cursor-2', [
      messageEvent('$evt-2', '- second'),
    ]))

    stopIngest = ingestEffect.start({repo})

    await vi.waitFor(async () => {
      expect(await rowByContent('second'), 'ingest stalled on the first message').toBeDefined()
    }, {timeout: 10_000, interval: 50})
    expect(savedCursor()).toBe('cursor-2')
  }, 30_000)
})
