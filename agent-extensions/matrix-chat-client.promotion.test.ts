// @vitest-environment happy-dom
//
// Drives the REAL matrix ingest — the extension's own poll effect, its own
// promotion, its own write — against a CHILD-BACKED workspace, because that is
// the only configuration in which the hazard exists.
//
// What it pins (#594): a `key:: value` whose key already has a too-narrow
// definition must not reach the write — post-flip that aborts the tx, and
// ingest holds its cursor on a failed write.
//
// The mixed case is the point: one message carries a key that cannot be stored
// and a key that can, so a blanket refusal fails this as loudly as no refusal
// at all.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The extension imports the matrix SDK from a URL, which no test runner can
// fetch. Only two of its methods are on the ingest path.
//
// The stub answers BY CURSOR, the way a homeserver does, and that is what
// makes a stall observable: a client that does not advance its cursor is
// handed the same events again, forever. A stub that ignored `since` would
// hand out the next message instead, and no test here could see a stall.
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

import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {createElement, type ComponentType} from 'react'
import {RepoContext} from '@/context/repo.js'
import * as toast from '@/utils/toast.js'
import type { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import type { AppExtension } from '@/facets/facet.js'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage.js'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import { siblingPrecedes } from '@/data/orderKey.js'
import { propertyFieldContent } from '@/data/propertyChildren.js'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi.js'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { diagnosticsFacet, type DiagnosticSourceContribution } from '@/plugins/diagnostics/facet.js'

import matrixContributions, {
  autoStartProp,
  homeserverProp,
  matrixChatPrefsType,
  matrixIngestEffect,
  messageNodeId,
  nextBatchKey,
  pollLoop,
  tokenKey,
  roomIdProp,
} from './matrix-chat-client.tsx'

const WS = 'ws-matrix'
const HOMESERVER = 'https://matrix.test'
const ROOM = '!room:matrix.test'
const destination = {workspaceId: WS, baseUrl: HOMESERVER, roomId: ROOM}
const SHARED_EVENT_ID = '$evt-shared'

/** The app shell owns mounts and effects; a repo-level runtime takes neither.
 *  `matrixIngestEffect.start({repo})` is then called by hand — exactly what
 *  `liveRuntime` does with it. */
const matrixDataExtensions = (matrixContributions as unknown as Array<{facet?: {id: string}}>)
  .filter(c => 'facet' in c && c.facet?.id !== 'core.app-mounts' && c.facet?.id !== 'core.app-effects')
  .map(c => c as unknown) as AppExtension[]

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

const configureIngest = async (repo: Repo): Promise<void> => {
  window.localStorage.setItem(tokenKey(destination), 'secret-token')
  window.localStorage.setItem(
    nextBatchKey(destination),
    JSON.stringify({nextBatch: 'cursor-0', savedAt: 1}),
  )
  const block = await getPluginPrefsBlock(repo, WS, repo.user, matrixChatPrefsType)
  await block.set(homeserverProp, HOMESERVER)
  await block.set(roomIdProp, ROOM)
  await block.set(autoStartProp, true)
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

const rowByContent = async (content: string): Promise<{id: string} | undefined> =>
  (await sharedDb.db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE deleted = 0 AND content = ?',
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

type MessageRow = {
  id: string
  parent_id: string | null
  content: string
  orderKey: string
  properties_json: string
  is_field_form: number | null
}

const messageRows = (rootId: string): Promise<MessageRow[]> => sharedDb.db.getAll<MessageRow>(
  `WITH RECURSIVE message(id) AS (
     SELECT id FROM blocks WHERE id = ? AND deleted = 0
     UNION ALL
     SELECT b.id FROM blocks b JOIN message ON b.parent_id = message.id
      WHERE b.deleted = 0
   )
   SELECT id, parent_id, content, order_key AS orderKey, properties_json, is_field_form
     FROM blocks JOIN message USING (id)`,
  [rootId],
)

const savedCursor = (): string | null => {
  const raw = window.localStorage.getItem(nextBatchKey(destination))
  return raw ? (JSON.parse(raw) as {nextBatch: string}).nextBatch : null
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
const resetReplica = async (): Promise<void> => {
  timeline.clear()
  window.localStorage.clear()
  await resetTestDb(sharedDb.db)
  await seedFlippedWorkspace()
}
beforeEach(resetReplica)
afterEach(() => {
  stopIngest?.()
  stopIngest = undefined
})

describe('Matrix setup in a child-backed workspace', () => {
  it.each(['Save', 'Bind saved device token'] as const)('%s persists the settings and device credential', async button => {
    const repo = await setup()
    const prefs = await getPluginPrefsBlock(repo, WS, repo.user, matrixChatPrefsType)
    const initialRoom = '!previous:matrix.test'
    await prefs.set(roomIdProp, initialRoom)
    await prefs.set(autoStartProp, false)
    const legacyTokenKey = 'knowledge-medium:matrix:token:v1'
    const legacyCursorKey = `knowledge-medium:matrix-messages:state:v1:${HOMESERVER}:${ROOM}`
    const bind = button === 'Bind saved device token'
    if (bind) {
      localStorage.setItem(legacyTokenKey, 'setup-token')
      localStorage.setItem(legacyCursorKey, JSON.stringify({nextBatch: 'old-cursor', savedAt: 1}))
    }
    const errors = vi.spyOn(toast, 'showError')
    const successes = vi.spyOn(toast, 'showSuccess')
    try {
      const mount = matrixContributions.find(c => (c.value as {id?: string}).id === 'matrix.setup-dialog')!.value as {component: ComponentType}
      const connect = matrixContributions.find(c => (c.value as {id?: string}).id === 'matrix.connect')!.value as unknown as {handler: () => void}
      render(createElement(RepoContext.Provider, {value: repo}, createElement(mount.component)))
      act(() => connect.handler())
      await screen.findByDisplayValue(initialRoom)
      fireEvent.change(screen.getByLabelText('Homeserver URL'), {target: {value: HOMESERVER}})
      fireEvent.change(screen.getByLabelText('Room ID'), {target: {value: ROOM}})
      if (!bind) fireEvent.change(screen.getByLabelText('Access token'), {target: {value: 'setup-token'}})
      fireEvent.click(await screen.findByRole('button', {name: button}))
      await waitFor(() => expect(errors.mock.calls.length + successes.mock.calls.length).toBeGreaterThan(0))
      expect(errors.mock.calls).toEqual([])
      expect(successes).toHaveBeenCalledWith('Matrix connected.')
      expect(await cellBag(prefs.id)).toMatchObject({
        [homeserverProp.name]: HOMESERVER, [roomIdProp.name]: ROOM, [autoStartProp.name]: true,
        'matrix:connected': true,
      })
      expect(localStorage.getItem(tokenKey(destination))).toBe('setup-token')
      expect(savedCursor()).toBe(bind ? 'old-cursor' : null)
      expect(localStorage.getItem(legacyTokenKey)).toBeNull()
    } finally {
      cleanup()
      errors.mockRestore()
      successes.mockRestore()
    }
  })
})

describe('matrix ingest into a child-backed workspace', () => {
  it('retries a message from the saved cursor after the workspace view catches up', async () => {
    const repo = await setup()
    await configureIngest(repo)
    const eventId = '$evt-view-gap'
    const batch = syncBody('cursor-1', [messageEvent(eventId, '- hello\n  - note:: from the room')])
    const rootId = messageNodeId(WS, eventId, [0])
    const diagnostics = matrixContributions.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution
    const since: Array<string | undefined> = []
    const pollOnce = async () => {
      const controller = new AbortController()
      let delivered = false
      const unsubscribe = diagnostics.subscribe(() => {
        if (diagnostics.getSnapshot()?.severity === 'warning') queueMicrotask(() => controller.abort())
      })
      try {
        await pollLoop(repo, {...destination, accessToken: 'fixture', autoStart: true}, controller.signal, {
          http: {authedRequest: async (_method: string, _path: string, query: {since?: string}) => {
            since.push(query.since)
            if (!delivered && query.since === 'cursor-0') {
              delivered = true
              return batch
            }
            controller.abort()
            return {}
          }},
        })
      } finally {
        unsubscribe()
        controller.abort()
      }
    }

    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('pending-definition', 'upsert')",
    )
    expect(await repo.workspaceViewGap(WS)).toMatchObject({transient: true, reason: expect.stringContaining('draining into')})
    expect(repo.propertySchemas.get('matrix:note')).toBeUndefined()
    await pollOnce()
    expect(diagnostics.getSnapshot()?.detail).toMatch(/not caught up.*draining into/i)
    expect(since).toEqual(['cursor-0'])
    expect(savedCursor()).toBe('cursor-0')
    expect(await messageRows(rootId)).toEqual([])
    expect(repo.userSchemas.getSchemaBlockId('matrix:note')).toBeUndefined()

    await sharedDb.db.execute("DELETE FROM blocks_synced_changes WHERE id = 'pending-definition'")
    expect(await repo.workspaceViewGap(WS)).toBeNull()
    await pollOnce()
    expect(since).toEqual(['cursor-0', 'cursor-0', 'cursor-1'])
    expect(savedCursor()).toBe('cursor-1')
    expect(await cellBag(rootId)).toMatchObject({'matrix:note': 'from the room'})
    const fieldId = repo.userSchemas.getSchemaBlockId('matrix:note')
    expect(fieldId).toBeDefined()
    const rows = await messageRows(rootId)
    expect(rows.map(row => row.content)).not.toContain('note:: from the room')
    const fields = rows.filter(row =>
      row.parent_id === rootId && row.is_field_form === 1 && row.content === propertyFieldContent(fieldId!))
    expect(fields).toHaveLength(1)
    expect(await childContents(fields[0].id)).toEqual(['from the room'])
  })

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

      stopIngest = matrixIngestEffect.start({repo})

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

  it('keeps a declined bullet declined, even where the value would narrow enough to fit', async () => {
    // A withdrawal has to survive the rest of the walk. The same key can
    // accumulate from several depths at once: judged together they are a list,
    // and judged one level down the nested one alone is a scalar a `date` can
    // hold. If the withdrawal only un-bubbles, the deeper pass re-promotes
    // that bullet onto its parent — a parent the parent-level pass already
    // consumed and is about to drop, taking the rescued value with it.
    const repo = await setup()
    await repo.userSchemas.addSchema({name: 'matrix:when', presetId: 'date'})
    await configureIngest(repo)

    timeline.set('cursor-0', syncBody('cursor-1', [
      messageEvent('$evt-1', [
        '- hello',
        '  - note:: from the room',
        '    - when:: 2026-01-01',
        '  - when:: 2026-02-02',
      ].join('\n')),
    ]))

    stopIngest = matrixIngestEffect.start({repo})

    const message = await vi.waitFor(async () => {
      const row = await rowByContent('hello')
      expect(row, 'the message never landed').toBeDefined()
      return row!
    }, {timeout: 10_000, interval: 50})

    // Neither date can be stored under a `date` definition as a pair, so both
    // bullets stay. The one that would fit alone must not be spirited away.
    const everyContent = (await sharedDb.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE deleted = 0',
    )).map(r => r.content)
    expect(everyContent).toContain('when:: 2026-01-01')
    expect(everyContent).toContain('when:: 2026-02-02')
    expect((await cellBag(message.id))['matrix:when']).toBeUndefined()
  }, 30_000)

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

    stopIngest = matrixIngestEffect.start({repo})

    await vi.waitFor(async () => {
      expect(await rowByContent('second'), 'ingest stalled on the first message').toBeDefined()
      // Inside the poll, like the sibling test above: the cursor save is a
      // SEPARATE write from the message row, so a poll that stops at the row can
      // still read the previous cursor.
      expect(savedCursor()).toBe('cursor-2')
    }, {timeout: 10_000, interval: 50})
  }, 30_000)

  it('merges conflicting-schema replicas without shifting attribute or nested message rows', async () => {
    const rootId = messageNodeId(WS, SHARED_EVENT_ID, [0])
    const makeReplica = async (presetId: 'number' | 'string') => {
      const repo = await setup()
      const schema = await repo.userSchemas.addSchema({name: 'matrix:count', presetId})
      await configureIngest(repo)
      timeline.set('cursor-0', syncBody('cursor-1', [messageEvent(
        SHARED_EVENT_ID,
        [
          '- hello',
          '  - count:: many',
          '  - ordinary',
          '    - count:: nested many',
          '    - nested ordinary',
        ].join('\n'),
      )]))

      // Give the writers different jitter so preserving order cannot depend
      // on a favorable draw from either one.
      const random = vi.spyOn(Math, 'random').mockReturnValue(presetId === 'string' ? 0.1 : 0.9)
      try {
        stopIngest = matrixIngestEffect.start({repo})
        await vi.waitFor(() => expect(savedCursor()).toBe('cursor-1'), {timeout: 10_000, interval: 50})
        const rows = await messageRows(rootId)
        return {
          rows: new Map(rows.map(row => [row.id, row])),
          countFieldContent: propertyFieldContent(schema.fieldId),
        }
      } finally {
        stopIngest?.()
        stopIngest = undefined
        random.mockRestore()
      }
    }

    // Each reset/reseed is an independent replica with the same event root.
    const {rows: promotingRows, countFieldContent} = await makeReplica('string')
    await resetReplica()
    const {rows: decliningRows} = await makeReplica('number')
    const countId = messageNodeId(WS, SHARED_EVENT_ID, [0, 0])
    const ordinaryId = messageNodeId(WS, SHARED_EVENT_ID, [0, 1])
    const nestedCountId = messageNodeId(WS, SHARED_EVENT_ID, [0, 1, 0])
    const nestedOrdinaryId = messageNodeId(WS, SHARED_EVENT_ID, [0, 1, 1])
    const promotedCounts = [[rootId, 'many', countId], [ordinaryId, 'nested many', nestedCountId]] as const
    for (const [parentId, value, bulletId] of promotedCounts) {
      const promoting = promotingRows.get(parentId)
      const declining = decliningRows.get(parentId)
      expect.soft(promoting && JSON.parse(promoting.properties_json)['matrix:count']).toBe(value)
      expect.soft(declining && Object.hasOwn(JSON.parse(declining.properties_json), 'matrix:count'),
        `declining parent omits property: ${value}`).toBe(false)
      expect.soft(promoting && promotingRows.has(bulletId), `promoting parent omits bullet: ${value}`).toBe(false)
    }

    for (const [id, label] of [[ordinaryId, 'ordinary'], [nestedOrdinaryId, 'nested ordinary']]) {
      const promoting = promotingRows.get(id)
      const declining = decliningRows.get(id)
      expect.soft(promoting && declining && promoting.orderKey === declining.orderKey,
        `both replicas keep sibling order: ${label}`).toBe(true)
    }

    const eventMetadata = (row: MessageRow) =>
      Object.fromEntries(Object.entries(JSON.parse(row.properties_json) as Record<string, unknown>)
        .filter(([key]) => key.startsWith('matrix-event:')))
    const rootMetadata = {
      'matrix-event:id': SHARED_EVENT_ID,
      'matrix-event:room': ROOM,
      'matrix-event:url': `https://matrix.to/#/${ROOM}/${SHARED_EVENT_ID}`,
      'matrix-event:author': '@someone:matrix.test',
      'matrix-event:timestamp': 1_700_000_000_000,
    }

    for (const [firstRows, secondRows, uploadOrder] of [
      [promotingRows, decliningRows, 'promoter first'],
      [decliningRows, promotingRows, 'decliner first'],
    ] as const) {
      // The sync conflict policy is first-create-wins for rows sharing an id.
      // This stand-in covers creates; later PATCH uploads are outside it.
      const merged = new Map<string, MessageRow>()
      for (const row of [...firstRows.values(), ...secondRows.values()]) {
        if (!merged.has(row.id)) merged.set(row.id, row)
      }
      const root = merged.get(rootId)
      const countBullet = merged.get(countId)
      const ordinary = merged.get(ordinaryId)
      const nestedCount = merged.get(nestedCountId)
      const nestedOrdinary = merged.get(nestedOrdinaryId)

      const children = (parentId: string): MessageRow[] =>
        [...merged.values()].filter(row => row.parent_id === parentId).sort((a, b) =>
          a.id === b.id ? 0 : siblingPrecedes(a, b) ? -1 : 1)

      const contents = (parentId: string): string[] => children(parentId)
        .map(row => row.is_field_form === 1 ? 'property field' : row.content)

      for (const [id, label] of [
        [countId, 'count'], [ordinaryId, 'ordinary'], [nestedCountId, 'nested count'], [nestedOrdinaryId, 'nested ordinary'],
      ]) {
        const row = merged.get(id)
        expect.soft(row && (JSON.parse(row.properties_json).types ?? []).includes('matrix-message'),
          `${uploadOrder}: ${label} omits message type`).toBe(false)
        expect.soft(row && eventMetadata(row), `${uploadOrder}: ${label} omits event metadata`).toEqual({})
      }
      for (const [id, label] of [[countId, 'count'], [nestedCountId, 'nested count'], [nestedOrdinaryId, 'nested ordinary']]) {
        expect.soft(merged.get(id) && children(id), `${uploadOrder}: ${label} is a leaf`).toEqual([])
      }

      expect.soft(root?.content).toBe('hello')
      expect.soft(root && root.parent_id === promotingRows.get(rootId)?.parent_id).toBe(true)
      expect.soft(countBullet).toMatchObject({content: 'count:: many', parent_id: rootId})
      expect.soft(ordinary).toMatchObject({content: 'ordinary', parent_id: rootId})
      expect.soft(nestedCount).toMatchObject({content: 'count:: nested many', parent_id: ordinaryId})
      expect.soft(nestedOrdinary).toMatchObject({content: 'nested ordinary', parent_id: ordinaryId})
      expect.soft(root && JSON.parse(root.properties_json).types).toEqual(['matrix-message'])
      expect.soft(root && eventMetadata(root)).toEqual(rootMetadata)

      // In this fixture the count field and the root's type and metadata
      // fields sort between the two authored siblings.
      const rootFields = Array<string>(Object.keys(rootMetadata).length + 2).fill('property field')
      expect.soft(contents(rootId), uploadOrder).toEqual(['count:: many', ...rootFields, 'ordinary'])
      expect.soft(contents(ordinaryId), uploadOrder)
        .toEqual(['count:: nested many', 'property field', 'nested ordinary'])

      for (const [parentId, value] of promotedCounts) {
        const fields = children(parentId).filter(row =>
          row.is_field_form === 1 && row.content === countFieldContent)
        expect.soft(fields, uploadOrder).toHaveLength(1)
        expect.soft(fields.flatMap(field => children(field.id)).map(row => row.content)).toEqual([value])
      }
    }
  }, 30_000)
})
