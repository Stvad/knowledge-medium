import { actionsFacet, appEffectsFacet, appMountsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import {
  blockGutterItemsFacet,
  type BlockGutterItem,
  type BlockGutterItemContribution,
} from '@/extensions/blockInteraction.js'
import {
  diagnosticsFacet,
  type DiagnosticSnapshot,
  type DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import {
  ChangeScope, seedType, seedProperty, definePropertyEditorOverride,
  type BlockData, type PropertyEditorProps, type Tx,
} from '@/data/api/index.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getPluginPrefsBlock, pluginPrefsBlockId } from '@/data/stateBlocks.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import { propertyEditorOverridesFacet, definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { abortableSleep } from '@/utils/abortableSleep.js'
import { showError, showInfo, showSuccess } from '@/utils/toast.js'
import { useRepo } from '@/context/repo.js'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { useHandle } from '@/hooks/block.js'
import type { BlockRenderer } from '@/types.js'
import { keyAtEnd, keysBetween, originalSiblingKeys } from '@/data/orderKey.js'
import { createOrRestoreTargetBlock } from '@/data/targets.js'
import { addBlockTypeToProperties, hasBlockType, showPropertiesProp } from '@/data/properties.js'
import { getOrCreateDailyNoteInTx, todayIso } from '@/plugins/daily-notes/dailyNotes.js'
import {
  computePromotedFromChildren,
  ensurePromotedPropertySchemas,
  isRegistrablePropertyName,
  promotedValueAcceptorFor,
  type PromotionOptions,
} from '@/plugins/roam-import/plan.js'
import { navigate } from '@/utils/navigation.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import * as matrixSdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle'

// ---------------------------------------------------------------------------
// constants

const source = 'matrix-chat-client'
const MATRIX_MESSAGE_TYPE = 'matrix-message'
const TAG_BLOCK_CONTENT = '[[matrix-messages]]'
const POLL_ERROR_DELAY_MS = 5_000

// Stable namespace for deterministic block ids. Derived ids (the per-day tag
// block and every node of a message tree) are a uuidv5 of the workspace + a
// plugin-internal key under this namespace, so two devices that independently
// ingest the same matrix event compute the *same* ids and PowerSync merges
// their writes instead of duplicating the message. Picked once; never change.
const MATRIX_NS = '9839e327-a96a-4974-acb1-128fc44878b8'

const STOPPED_PREFIX = 'knowledge-medium:matrix:stopped:v1:'
const TOKEN_PREFIX = 'knowledge-medium:matrix:token:v2:'
// Pre-binding storage is read only by setup and the legacy config migration.
const LEGACY_TOKEN_KEY = 'knowledge-medium:matrix:token:v1'
const LEGACY_BATCH_PREFIX = 'knowledge-medium:matrix-messages:state:v1:'
const legacyNextBatchKey = ({baseUrl, roomId}: Pick<MatrixDestination, 'baseUrl' | 'roomId'>) => LEGACY_BATCH_PREFIX + baseUrl + ':' + roomId
// one-time migration marker (per workspace) — see migrateEventNamespace.
const MIGRATION_FLAG_PREFIX = 'knowledge-medium:matrix:migrated:event-ns:v1'
// pre-refactor config blob (homeserver/room/autoStart/token in one localStorage
// JSON) + a per-device flag for the one-time carry-over (see migrateLegacyConfig).
const LEGACY_CONFIG_KEY = 'knowledge-medium:matrix-messages:config:v1'
const LEGACY_CONFIG_FLAG = 'knowledge-medium:matrix:legacy-config-migrated:v1'

// Setup-dialog visibility — a typed module store, NOT a window CustomEvent.
// The connect action / header button flip it; the mounted dialog reads it
// with useSyncExternalStore (the mechanism the app's own DialogHost uses).
let setupOpen = false
const setupListeners = new Set<() => void>()
const setSetupOpen = (next: boolean) => {
  setupOpen = next
  setupListeners.forEach((notify) => notify())
}
const subscribeSetupOpen = (notify: () => void) => {
  setupListeners.add(notify)
  return () => setupListeners.delete(notify)
}

// Genuine broadcast: wakes the running ingest effect to restart (not a
// dialog/toggle), so it stays a window CustomEvent.
const RESTART_EVENT = 'matrix:ingest:restart'

// ---------------------------------------------------------------------------
// properties — config lives on the per-plugin prefs block; the access token
// stays in localStorage. Event metadata on message blocks lives under the
// reserved `matrix-event:*` namespace so it can never collide with `key::value`
// attributes promoted out of message *content* (which keep the `matrix:*`
// namespace — see matrixPromotionOptions below).

export const homeserverProp = seedProperty({
  seedKey: extensionPropertySeedKey('homeserver'),
  revision: 1,
  name: 'matrix:homeserver',
  preset: 'string',
  defaultValue: 'https://matrix.org',
  changeScope: ChangeScope.BlockDefault,
})
export const roomIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('room-id'),
  revision: 1,
  name: 'matrix:roomId',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
export const autoStartProp = seedProperty({
  seedKey: extensionPropertySeedKey('auto-start'),
  revision: 1,
  name: 'matrix:autoStart',
  preset: 'boolean',
  defaultValue: true,
  changeScope: ChangeScope.BlockDefault,
})
// UI hint mirrored onto the prefs block so the settings panel can render
// connectivity alongside the credential stored on this device.
const connectedHintProp = seedProperty({
  seedKey: extensionPropertySeedKey('connected'),
  revision: 1,
  name: 'matrix:connected',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

// Per-message event metadata. Reserved `matrix-event:*` namespace.
const eventIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('event-id'),
  revision: 1,
  name: 'matrix-event:id',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const eventRoomProp = seedProperty({
  seedKey: extensionPropertySeedKey('event-room'),
  revision: 1,
  name: 'matrix-event:room',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const eventUrlProp = seedProperty({
  seedKey: extensionPropertySeedKey('event-url'),
  revision: 1,
  name: 'matrix-event:url',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const eventAuthorProp = seedProperty({
  seedKey: extensionPropertySeedKey('event-author'),
  revision: 1,
  name: 'matrix-event:author',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const eventTimestampProp = seedProperty({
  seedKey: extensionPropertySeedKey('event-timestamp'),
  revision: 1,
  name: 'matrix-event:timestamp',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const matrixChatPrefsType = seedType({
  seedKey: extensionTypeSeedKey('prefs'),
  revision: 1,
  id: 'matrix-chat-prefs',
  label: 'Matrix',
  // Prefs container is plumbing for the # dropdown (typing #Matrix
  // must offer creating the user's own type, not tag with this);
  // the chip stays informative on the container block itself.
  hideFromCompletion: true,
  properties: [homeserverProp, roomIdProp, autoStartProp, connectedHintProp],
})
const matrixMessageType = seedType({
  seedKey: extensionTypeSeedKey('message'),
  revision: 1,
  id: MATRIX_MESSAGE_TYPE,
  label: 'Matrix message',
  description: 'A message ingested from a Matrix room.',
  properties: [eventIdProp, eventRoomProp, eventUrlProp, eventAuthorProp, eventTimestampProp],
})

const checkpointProp = seedProperty({
  seedKey: extensionPropertySeedKey('checkpoint-next-batch'),
  revision: 1,
  name: 'matrix-checkpoint:nextBatch',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const checkpointType = seedType({
  seedKey: extensionTypeSeedKey('checkpoint'),
  revision: 1,
  id: 'matrix-checkpoint',
  label: 'Matrix room checkpoint',
  hideFromCompletion: true,
  properties: [homeserverProp, roomIdProp, checkpointProp],
})

// Mapping for the one-time rename of the legacy `matrix:*` event-metadata
// keys onto the reserved `matrix-event:*` namespace.
const EVENT_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['matrix:eventId', eventIdProp.name],
  ['matrix:roomId', eventRoomProp.name],
  ['matrix:url', eventUrlProp.name],
  ['matrix:author', eventAuthorProp.name],
  ['matrix:timestamp', eventTimestampProp.name],
]

// ---------------------------------------------------------------------------
// config / secret storage

const httpsUrl = (value: string): URL | null => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const originWithoutPath = (url: URL | null) => url?.pathname === '/' ? url.origin : ''

interface MatrixDestination {
  workspaceId: string
  baseUrl: string
  roomId: string
}

const destinationKey = ({workspaceId, baseUrl, roomId}: MatrixDestination) =>
  JSON.stringify([workspaceId, baseUrl, roomId])
export const tokenKey = (destination: MatrixDestination) =>
  TOKEN_PREFIX + destinationKey(destination)
export const stoppedKey = (destination: MatrixDestination) =>
  STOPPED_PREFIX + destinationKey(destination)
export const nextBatchKey = (destination: MatrixDestination) =>
  `knowledge-medium:matrix-messages:state:v2:${destinationKey(destination)}`

const loadToken = (destination: MatrixDestination) => window.localStorage.getItem(tokenKey(destination))
const pendingToken = () => window.localStorage.getItem(LEGACY_TOKEN_KEY)

const storageKeys = (prefix: string): string[] => {
  const storage = window.localStorage
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  return keys
}

const legacyCheckpoint = ({baseUrl, roomId}: MatrixDestination): string | null => {
  const storage = window.localStorage
  const current = storage.getItem(legacyNextBatchKey({baseUrl, roomId}))
  if (decodeNextBatch(current)) return current

  // The v1 key retains the server spelling (including its path). Split at
  // the Matrix room ID so an origin match cannot also match a room suffix.
  for (const key of storageKeys(LEGACY_BATCH_PREFIX)) {
    const pair = key.slice(LEGACY_BATCH_PREFIX.length)
    const separator = pair.indexOf(':!')
    if (separator < 0 || pair.slice(separator + 1) !== roomId) continue
    if (httpsUrl(pair.slice(0, separator))?.origin !== baseUrl) continue
    const raw = storage.getItem(key)
    if (decodeNextBatch(raw)) return raw
  }
  return null
}

const eligibleLegacyToken = (destination: MatrixDestination) => {
  const token = pendingToken()
  if (!token) return null
  if (legacyCheckpoint(destination)) return token
  const legacy = readLegacyConfig()
  return legacy?.roomId === destination.roomId &&
    httpsUrl(legacy.baseUrl)?.origin === destination.baseUrl &&
    (!legacy.accessToken || legacy.accessToken === token) ? token : null
}

const clearLegacyTokens = () => {
  const legacy = readLegacyConfig()
  if (legacy?.accessToken) {
    delete legacy.accessToken
    window.localStorage.setItem(LEGACY_CONFIG_KEY, JSON.stringify(legacy))
  }
  window.localStorage.removeItem(LEGACY_TOKEN_KEY)
}

const bindToken = (destination: MatrixDestination, token: string) => {
  const storage = window.localStorage
  const checkpointKey = nextBatchKey(destination)
  if (storage.getItem(checkpointKey) === null) {
    const cursor = legacyCheckpoint(destination)
    if (cursor !== null) storage.setItem(checkpointKey, cursor)
  }
  storage.removeItem(stoppedKey(destination))
  storage.setItem(tokenKey(destination), token)
  clearLegacyTokens()
}

const forgetDeviceTokens = () => {
  if (!window.confirm('Forget all Matrix tokens in this browser across all workspaces?')) return
  for (const key of storageKeys(TOKEN_PREFIX)) window.localStorage.removeItem(key)
  clearLegacyTokens()
  requestRestart()
  setSetupOpen(false)
  showInfo('Removed Matrix tokens from this device.')
}

interface MatrixConfig extends MatrixDestination {
  accessToken: string
  autoStart: boolean
}
interface MatrixConfigCandidate extends MatrixDestination {
  accessToken: string | null
  autoStart: boolean
}
const prefsBlock = (repo: any) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return getPluginPrefsBlock(repo, workspaceId, repo.user, matrixChatPrefsType)
}

const destinationFromPrefs = (prefs: Block): MatrixDestination => ({
  workspaceId: prefs.data.workspaceId,
  baseUrl: originWithoutPath(httpsUrl(prefs.get(homeserverProp))),
  roomId: prefs.get(roomIdProp),
})

const loadConfig = (prefs: Block): MatrixConfigCandidate => {
  const destination = destinationFromPrefs(prefs)
  return {...destination, accessToken: loadToken(destination), autoStart: prefs.get(autoStartProp) && !window.localStorage.getItem(stoppedKey(destination))}
}

const MATRIX_DIAGNOSTIC_ID = 'matrix-chat-client'
const MATRIX_CONFIGURE_ACTION_ID = 'matrix.configure'
const matrixDiagnosticListeners = new Set<() => void>()
let matrixDiagnosticSnapshot: DiagnosticSnapshot | null = null

const matrixDiagnosticSame = (
  left: DiagnosticSnapshot | null,
  right: DiagnosticSnapshot | null,
): boolean => {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.severity === right.severity &&
    left.summary === right.summary &&
    left.detail === right.detail &&
    left.actionId === right.actionId &&
    left.actionLabel === right.actionLabel &&
    left.nudge === right.nudge
  )
}

const setMatrixDiagnostic = (next: DiagnosticSnapshot | null): void => {
  if (matrixDiagnosticSame(matrixDiagnosticSnapshot, next)) return
  matrixDiagnosticSnapshot = next
  matrixDiagnosticListeners.forEach(notify => notify())
}

const clearMatrixDiagnostic = (): void => {
  setMatrixDiagnostic(null)
}

const matrixWarningDiagnostic = (summary: string, detail: string): DiagnosticSnapshot => ({
  severity: 'warning',
  summary,
  detail,
  actionId: MATRIX_CONFIGURE_ACTION_ID,
  actionLabel: 'Open settings',
  nudge: true,
})

const unconfiguredMatrixDiagnostic = matrixWarningDiagnostic(
  'Matrix ingest is not configured',
  'Open Matrix settings and configure homeserver and room, then save a token.',
)
const missingTokenMatrixDiagnostic = matrixWarningDiagnostic(
  'Matrix token is missing',
  'Save an access token in Matrix settings so this device can ingest messages.',
)
const retryErrorMatrixDiagnostic = (message: string): DiagnosticSnapshot =>
  matrixWarningDiagnostic('Matrix ingest is retrying', message)
const hardErrorMatrixDiagnostic = (message: string): DiagnosticSnapshot =>
  matrixWarningDiagnostic('Matrix ingest error', message)

const matrixDiagnosticSource: DiagnosticSourceContribution = {
  id: MATRIX_DIAGNOSTIC_ID,
  label: 'Matrix',
  subscribe: (notify) => {
    matrixDiagnosticListeners.add(notify)
    return () => {
      matrixDiagnosticListeners.delete(notify)
    }
  },
  getSnapshot: () => matrixDiagnosticSnapshot,
}

// ---------------------------------------------------------------------------
// long-poll cursor (localStorage)

const validBatch = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const syncPosition = (body: {next_batch?: unknown} | null | undefined): string => {
  if (!validBatch(body?.next_batch)) throw new Error('Matrix returned an invalid sync position.')
  return body.next_batch
}

const decodeNextBatch = (raw: string | null): string | null => {
  if (!raw) return null
  try {
    const state = JSON.parse(raw)
    return validBatch(state?.nextBatch) ? state.nextBatch : null
  } catch {
    return null
  }
}

const loadNextBatch = (config: MatrixConfig) => decodeNextBatch(window.localStorage.getItem(nextBatchKey(config)))

// Preserve the v1 {nextBatch, savedAt} shape so setup can copy a checkpoint verbatim.
const saveNextBatch = (config: MatrixConfig, nextBatch: string) =>
  window.localStorage.setItem(nextBatchKey(config), JSON.stringify({nextBatch, savedAt: Date.now()}))

export const checkpointId = (config: MatrixDestination) =>
  pluginBlockId(config.workspaceId, MATRIX_NS, 'checkpoint:' + destinationKey(config))

const checkpointExists = 'This room already has a shared Matrix checkpoint. Resume ingest.'
const requireCheckpoint = 'No shared Matrix checkpoint yet. On the original writer, publish its saved position. For a new room, choose Start fresh.'
const damagedCheckpoint = 'Invalid shared Matrix checkpoint. Restore the room checkpoint from a known-good backup.'

const checkpointPosition = (row: BlockData | null, config: MatrixDestination): string => {
  if (!row) throw new Error(requireCheckpoint)
  if (row.deleted || row.workspaceId !== config.workspaceId || !hasBlockType(row, checkpointType.id)) {
    throw new Error(damagedCheckpoint)
  }
  const value = row.properties[checkpointProp.name]
  if (!validBatch(value)) throw new Error(damagedCheckpoint)
  return value
}

// Dismissing a rejected upload removes its queue entry but leaves the local
// message intact. Only server echoes can establish that its tree reached peers.
// The staging table keeps block identities visible in encrypted workspaces too.
const hasUnconfirmedBlocks = (tx: Tx, workspaceId: string, processed?: ReadonlySet<string>) => {
  // A legacy cursor has no ledger of processed IDs. Even an untyped, renamed
  // block could be an unsent message. Check the workspace once on adoption.
  const candidates = processed
    ? {
        sql: `SELECT value FROM json_each(?)
              UNION
              SELECT b.id FROM blocks b JOIN candidates p ON b.parent_id = p.id
              WHERE b.workspace_id = ? AND b.deleted = 0`,
        params: [JSON.stringify([...processed]), workspaceId],
      }
    : {sql: 'SELECT id FROM blocks WHERE workspace_id = ? AND deleted = 0', params: [workspaceId]}
  return tx.readDb.getOptional(
    `WITH RECURSIVE candidates(id) AS (${candidates.sql})
     SELECT 1 FROM candidates c WHERE NOT EXISTS (
       SELECT 1 FROM blocks_synced s WHERE s.id = c.id AND s.workspace_id = ?
     ) LIMIT 1`,
    [...candidates.params, workspaceId],
  )
}

const writeCheckpoint = (
  repo: Repo, config: MatrixConfig, position: string, operation: 'fresh' | 'adopt' | {processed: ReadonlySet<string>}, verify: () => void,
): Promise<boolean> => repo.tx(async (tx: Tx) => {
  // A refused message transaction can leave the upload queue before later
  // transactions upload. Keep the shared position behind both queues.
  if (operation !== 'fresh') {
    if (await tx.readDb.getOptional('SELECT 1 FROM ps_crud UNION ALL SELECT 1 FROM ps_crud_rejected LIMIT 1')) return false
    if (await hasUnconfirmedBlocks(tx, config.workspaceId, operation === 'adopt' ? undefined : operation.processed)) return false
  }
  const id = checkpointId(config)
  if (typeof operation === 'object') {
    checkpointPosition(await tx.get(id), config)
    verify()
    await tx.setProperty(id, checkpointProp, position)
  } else {
    verify()
    const {inserted} = await tx.createOrGet({
      id, workspaceId: config.workspaceId, parentId: null, orderKey: 'a0',
      content: 'Matrix room checkpoint',
      properties: addBlockTypeToProperties({
        [homeserverProp.name]: config.baseUrl, [roomIdProp.name]: config.roomId, [checkpointProp.name]: position,
      }, checkpointType.id),
    }, {systemMint: true})
    if (!inserted) throw new Error(checkpointExists)
  }
  return true
}, {scope: ChangeScope.BlockDefault, skipUndo: true, description: 'Save Matrix room checkpoint'})

const verifyDestination = (repo: Repo, config: MatrixConfig) => {
  if (repo.activeWorkspaceId !== config.workspaceId || loadToken(config) !== config.accessToken) {
    throw new Error('The Matrix destination or device credential changed.')
  }
}

export const publishDeviceCheckpoint = async (repo: Repo, config: MatrixConfig) => {
  const position = loadNextBatch(config)
  if (!position) throw new Error('This device has no valid saved Matrix position.')
  if (!await writeCheckpoint(repo, config, position, 'adopt', () => verifyDestination(repo, config))) {
    throw new Error('Wait for uploads and a server copy of each live block in this workspace. Resolve rejected or stranded local writes before publishing a Matrix checkpoint.')
  }
}

export const startFresh = async (repo: Repo, config: MatrixConfig, signal: AbortSignal, client: any) => {
  if (await repo.load(checkpointId(config))) throw new Error(checkpointExists)
  verifyDestination(repo, config)
  const body = await fetchMatrixSync(config, null, signal, client)
  await writeCheckpoint(repo, config, syncPosition(body), 'fresh', () => {
    signal.throwIfAborted()
    verifyDestination(repo, config)
  })
}

// ---------------------------------------------------------------------------
// matrix sync

const syncFilter = (config: MatrixConfig) => ({
  room: {
    rooms: [config.roomId],
    timeline: {types: ['m.room.message'], limit: 30},
    state: {types: []},
    ephemeral: {types: []},
    account_data: {types: []},
  },
  presence: {types: []},
  account_data: {types: []},
})

const buildSyncQueryParams = (config: MatrixConfig, since: string | null) => {
  const queryParams: Record<string, string> = {
    timeout: since ? '30000' : '0',
    filter: JSON.stringify(syncFilter(config)),
  }
  if (since) queryParams.since = since
  return queryParams
}

const createMatrixClient = (config: MatrixConfig) =>
  matrixSdk.createClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  })

const fetchMatrixSync = (config: MatrixConfig, since: string | null, signal: AbortSignal, matrixClient: any) =>
  matrixClient.http.authedRequest(
    'GET',
    '/sync',
    buildSyncQueryParams(config, since),
    undefined,
    {abortSignal: signal},
  )

// /messages returns newest first. Reverse the complete interval so appending a
// recovered page never puts it after the more recent page fetched before it.
const fetchGapEvents = async (
  config: MatrixConfig, start: unknown, since: string, signal: AbortSignal,
  matrixClient: any, verifyWorkspace: () => void,
): Promise<any[]> => {
  if (typeof start !== 'string' || !start) throw new Error('Matrix history has an invalid starting token')
  const events: any[] = []
  const visited = new Set<string>()
  let from = start
  while (from !== since) {
    verifyWorkspace()
    if (visited.has(from)) throw new Error('Matrix history pagination repeated a token')
    visited.add(from)
    const page = await matrixClient.http.authedRequest(
      'GET', `/rooms/${encodeURIComponent(config.roomId)}/messages`,
      {from, to: since, dir: 'b', filter: JSON.stringify({types: ['m.room.message']}), limit: '100'},
      undefined, {abortSignal: signal},
    )
    if (!Array.isArray(page?.chunk)) throw new Error('Matrix history page has no chunk')
    for (const event of page.chunk) events.push(event)
    if (page.end === undefined) break
    if (typeof page.end !== 'string' || !page.end) throw new Error('Matrix history page has an invalid end token')
    from = page.end
  }
  return events.reverse()
}

const eventTimestamp = (event: any): number => {
  const ts = event?.origin_server_ts
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now()
}

// ---------------------------------------------------------------------------
// message text → markdown

const escapeRegex = (value: unknown) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const unwrapLinks = (value: unknown): string => {
  let text = String(value ?? '')
  text = text.replace(
    /\[(.*?)]\(https:\/\/roamresearch\.com\/#\/app\/[^/]+\/page\/[a-zA-Z-_0-9]+?\)/g,
    '$1',
  )

  const origin = window.location?.origin
  if (origin) {
    text = text.replace(new RegExp(`\\[(.*?)]\\(${escapeRegex(origin)}\\/[^)]*\\)`, 'g'), '$1')
  }

  return text
}

const mxcToHttpUrl = (mxcUrl: unknown, matrixClient: any): string => {
  if (typeof mxcUrl !== 'string' || !mxcUrl.startsWith('mxc://')) return (mxcUrl as string) || ''

  return matrixClient.mxcUrlToHttp(
    mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true,
    false,
  ) || ''
}

const getMediaLabel = (content: any, fallback: string): string =>
  String(content.body || content.filename || fallback).trim() || fallback

const getMessageText = (event: any, matrixClient: any): string => {
  const content = event.content && typeof event.content === 'object' ? event.content : {}
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : 'm.room.message'

  if (msgtype === 'm.audio') {
    return `{{[[audio]]: ${mxcToHttpUrl(content.url, matrixClient)} }}`
  }

  if (msgtype === 'm.image') {
    return `![${getMediaLabel(content, 'image')}](${mxcToHttpUrl(content.url, matrixClient)})`
  }

  if (msgtype === 'm.file' || msgtype === 'm.video') {
    return `[${getMediaLabel(content, msgtype)}](${mxcToHttpUrl(content.url, matrixClient)})`
  }

  if (msgtype === 'm.emote') return `* ${unwrapLinks(content.body)}`
  return unwrapLinks(content.body || content.url || msgtype)
}

interface BlockDef {
  content: string
  children?: BlockDef[]
  properties?: Record<string, unknown>
}

interface MessageNode extends BlockDef {
  /** Local schemas can drop different bullets during promotion. IDs and sibling
   *  order use the pre-promotion path so every writer agrees on surviving nodes. */
  parsedPath: number[]
  originalSiblingCount: number
  children?: MessageNode[]
}

const isListItem = (line: string) => /^(\s*)-\s+/.test(line)

const parseListItem = (line: string) => {
  const listItemMatch = line.match(/^(\s*)-\s+(.*)/)
  if (!listItemMatch) throw new Error('Invalid list item format')
  return {leadingSpaces: listItemMatch[1].length, content: listItemMatch[2]}
}

const isValidIndentation = (spaces: number) => spaces % 2 === 0

const appendContinuationLine = (block: BlockDef, line: string) => {
  block.content += `\n${line.trim()}`
}

const parseLines = (lines: string[], level = 0): BlockDef[] | null => {
  const blocks: BlockDef[] = []

  while (lines.length > 0) {
    const line = lines[0]

    if (isListItem(line)) {
      const {leadingSpaces, content} = parseListItem(line)
      if (!isValidIndentation(leadingSpaces)) return null

      const indentationLevel = leadingSpaces / 2
      if (indentationLevel < level) break

      if (indentationLevel > level) {
        if (!blocks.length) return null
        const nestedBlocks = parseLines(lines, indentationLevel)
        if (!nestedBlocks) return null
        const parent = blocks[blocks.length - 1]
        parent.children = [...(parent.children ?? []), ...nestedBlocks]
        continue
      }

      lines.shift()
      blocks.push({content})
      continue
    }

    if (!blocks.length) return null
    appendContinuationLine(blocks[blocks.length - 1], line)
    lines.shift()
  }

  return blocks
}

const parseMarkdownToBlockDefinitions = (markdownText: string): BlockDef[] => {
  const source = String(markdownText ?? '')
  const lines = source.split(/\r?\n/).filter(line => line.trim() !== '')
  const blocks = parseLines([...lines])
  return blocks && blocks.length ? blocks : [{content: source.trim() || '(empty message)'}]
}

// ---------------------------------------------------------------------------
// attribute promotion — `key::value` children of message *content* are hoisted
// onto their parent under the `matrix:*` namespace. This is deliberately
// distinct from the reserved `matrix-event:*` keys the ingest sets, so a chat
// message that happens to contain `timestamp::…` can never overwrite the
// event's own timestamp.

const matrixEventUrl = (roomId: string, eventId: string) => `https://matrix.to/#/${roomId}/${eventId}`
/** Ingest promotes SUBTRACTIVELY, so both declines have to happen here, before
 *  bubbling — see `PromotionOptions.acceptKey` / `acceptValue` for why. By
 *  NAME: `[[Page]]:: value`, whose name would contain `]]`. By VALUE:
 *  `count:: many` under an existing `number` definition (#594). */
const matrixPromotionOptions = (repo: any): PromotionOptions => ({
  namespacePrefix: 'matrix',
  transformKey: (key: string) => key.toLowerCase(),
  acceptKey: isRegistrablePropertyName,
  acceptValue: promotedValueAcceptorFor(repo),
})

const propertyValues = (value: unknown): unknown[] => Array.isArray(value) ? value : [value]

const samePropertyValue = (left: unknown, right: unknown) => Object.is(left, right)

const mergePropertyValue = (current: unknown, incoming: unknown): unknown => {
  if (current === undefined) return incoming

  const values: unknown[] = []
  for (const value of [...propertyValues(current), ...propertyValues(incoming)]) {
    if (!values.some(existing => samePropertyValue(existing, value))) {
      values.push(value)
    }
  }
  return values.length === 1 ? values[0] : values
}

const mergeProperties = (...propertyBags: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined => {
  const merged: Record<string, unknown> = {}
  for (const bag of propertyBags) {
    if (!bag || typeof bag !== 'object') continue
    for (const [key, value] of Object.entries(bag)) {
      merged[key] = mergePropertyValue(merged[key], value)
    }
  }
  return Object.keys(merged).length ? merged : undefined
}

const blockPathUid = (path: number[]) => `matrix-message:${path.join('.')}`

const toRoamBlock = (block: BlockDef, path: number[]): any => ({
  uid: blockPathUid(path),
  string: block.content,
  children: (block.children ?? []).map((child, index) => toRoamBlock(child, [...path, index])),
})

interface PromotionWalk {
  options: PromotionOptions
  /** Uids whose own text was hoisted — their bullets are subtracted. */
  bubbled: Set<string>
  /** Every uid the walk has already decided about, bubbled or declined. This
   *  is what deeper passes are given, NOT `bubbled`: a declined bullet that
   *  stayed eligible would be re-judged one level down against fewer of its
   *  key's values, accepted there, and hoisted onto a parent this level is
   *  already dropping. */
  settled: Set<string>
  diagnostics: string[]
}

const withPromotedMatrixProperties = (blocks: BlockDef[], walk: PromotionWalk, path: number[] = []): MessageNode[] =>
  blocks.flatMap((block, index) => {
    const blockPath = [...path, index]
    const children = Array.isArray(block.children) ? block.children : []
    const promotion = computePromotedFromChildren(
      children.map((child, childIndex) => toRoamBlock(child, [...blockPath, childIndex])),
      walk.settled,
      walk.options,
    )

    for (const uid of promotion.bubbled) {
      walk.bubbled.add(uid)
      walk.settled.add(uid)
    }
    for (const uid of promotion.declined) walk.settled.add(uid)
    walk.diagnostics.push(...promotion.diagnostics)

    const promotedChildren = withPromotedMatrixProperties(children, walk, blockPath)
    const next: MessageNode = {
      ...block,
      parsedPath: blockPath,
      originalSiblingCount: blocks.length,
      properties: mergeProperties(block.properties, promotion.promoted),
      children: promotedChildren.length ? promotedChildren : undefined,
    }

    // Subtractive promotion: drop a node whose own `key::value` was hoisted into
    // its parent's props AND whose whole subtree was consumed — the value lives
    // on as the derived prop. The anchor (root) is never bubbled, so it always
    // survives; a consumed attr that still has non-attr children is kept so they
    // aren't orphaned, which is also what keeps a DECLINED bullet nested under a
    // bubbled one. (Diverges from the Roam importer, which preserves attr blocks
    // for fidelity; chat ingest wants the literal bullet gone.)
    //
    // `!next.properties` is defence in depth, and deleting it fails no test:
    // `settled` already stops a deeper pass promoting anything onto a node this
    // one consumed. It is here because dropping a node discards its properties
    // silently, so the day that stops holding should not be a data-loss day.
    if (walk.bubbled.has(blockPathUid(blockPath)) && !next.children && !next.properties) return []
    return [next]
  })

const nestTopLevelBlocksUnderFirst = (blocks: BlockDef[]): BlockDef[] => {
  if (blocks.length <= 1) return blocks
  const [first, ...rest] = blocks
  return [{
    ...first,
    children: [...(first.children ?? []), ...rest],
  }]
}

/** Every node in a built tree, so promoted keys at any depth get a
 *  definition. `ensurePromotedPropertySchemas` normalizes in place, so these
 *  must be the SAME objects that are about to be written, not copies. */
const flattenBlockDefs = (blocks: BlockDef[]): BlockDef[] =>
  blocks.flatMap(block => [block, ...flattenBlockDefs(block.children ?? [])])

const createBlocksFromEvent = (
  event: any,
  matrixClient: any,
  repo: any,
): {tree: MessageNode[]; diagnostics: string[]} => {
  const text = getMessageText(event, matrixClient)
  const walk: PromotionWalk = {
    options: matrixPromotionOptions(repo),
    bubbled: new Set<string>(),
    settled: new Set<string>(),
    diagnostics: [],
  }
  const tree = withPromotedMatrixProperties(
    nestTopLevelBlocksUnderFirst(parseMarkdownToBlockDefinitions(text)),
    walk,
  )
  return {tree, diagnostics: walk.diagnostics}
}

// ---------------------------------------------------------------------------
// write the message into today's daily note

/** Uses MessageNode.parsedPath: `[0]` is the message root, `[0, 1]` its second child as written. */
export const messageNodeId = (workspaceId: string, eventId: string, path: number[]): string =>
  pluginBlockId(workspaceId, MATRIX_NS, `event:${eventId}:${path.join('.')}`)

type TreeWriter = Pick<Tx, 'create'>

const checkedTreeWriter = (tx: Tx, verifyWorkspace: () => void): TreeWriter => ({
  create: (...args) => {
    verifyWorkspace()
    return tx.create(...args)
  },
})

const createBlockTree = async (
  tx: TreeWriter,
  workspaceId: string,
  parentId: string,
  blockDefinitions: MessageNode[],
  orderKeys: string[],
  eventId: string,
  rootProperties?: Record<string, unknown>,
): Promise<void> => {
  for (const block of blockDefinitions) {
    const isMessageRoot = block.parsedPath.length === 1
    const merged = mergeProperties(isMessageRoot ? rootProperties : undefined, block.properties)
    // The message root is marked as a `matrix-message` block so its event
    // metadata renders under that type in the property panel. addBlockType…
    // re-encodes `types` through the list codec — going through our own
    // mergeProperties would collapse a single-element list back to a scalar.
    const properties = isMessageRoot
      ? addBlockTypeToProperties(merged ?? {}, MATRIX_MESSAGE_TYPE)
      : merged

    const id = await tx.create({
      id: messageNodeId(workspaceId, eventId, block.parsedPath),
      workspaceId,
      parentId,
      orderKey: orderKeys[block.parsedPath.at(-1)!],
      content: block.content,
      properties,
    })

    if (block.children?.length) {
      const childKeys = originalSiblingKeys(block.children[0].originalSiblingCount)
      await createBlockTree(tx, workspaceId, id, block.children, childKeys, eventId)
    }
  }
}

// Find this day's `[[matrix-messages]]` container, or create it. The id is
// deterministic per (workspace, date) so two devices ingesting on the same day
// converge on one container instead of creating two. We still prefer an
// existing block found by content scan — that reuses a container made by an
// older (random-id) build, or one already synced in from another device,
// rather than orphaning its messages under a fresh deterministic id.
const ensureMatrixTagBlock = async (
  tx: any,
  workspaceId: string,
  dailyId: string,
  iso: string,
  verifyWorkspace: () => void,
): Promise<string> => {
  const dailyChildren = await tx.childrenOf(dailyId, workspaceId)
  const existing = dailyChildren.find((child: any) => child.content.trim() === TAG_BLOCK_CONTENT)
  if (existing) return existing.id

  verifyWorkspace()
  const {id} = await createOrRestoreTargetBlock(tx, {
    id: pluginBlockId(workspaceId, MATRIX_NS, `tag:${iso}`),
    workspaceId,
    parentId: dailyId,
    orderKey: keyAtEnd(dailyChildren.at(-1)?.orderKey ?? null),
    freshContent: TAG_BLOCK_CONTENT,
  })
  return id
}

// The type index covers live rows. A deleted message keeps its stored type and
// metadata in its bag even though the index entry disappears.
// Keep property matches type-scoped because only a cursor predating the key rename can replay an untyped legacy tombstone.
const handledEvent = (
  db: Pick<Tx['readDb'], 'getOptional'>, workspaceId: string, eventId: string,
) => db.getOptional<{id: string}>(
  `SELECT id FROM blocks WHERE id = ? AND workspace_id = ?
   UNION ALL
   SELECT id FROM (
     SELECT b.id, b.properties_json FROM block_types t JOIN blocks b ON b.id = t.block_id
     WHERE t.workspace_id = ? AND t.type = 'matrix-message'
     UNION ALL
     SELECT id, properties_json FROM blocks WHERE workspace_id = ? AND deleted = 1
       AND EXISTS (SELECT 1 FROM json_each(properties_json, '$.types') WHERE value = 'matrix-message')
   ) WHERE ? IN (json_extract(properties_json, '$."matrix-event:id"'), json_extract(properties_json, '$."matrix:eventId"'))
   LIMIT 1`,
  [messageNodeId(workspaceId, eventId, [0]), workspaceId, workspaceId, workspaceId, eventId],
)

export const appendMatrixMessage = async (
  repo: any, config: MatrixConfig, event: any, matrixClient: any, verifyWorkspace: () => void,
): Promise<string | undefined> => {
  const eventId = typeof event.event_id === 'string' ? event.event_id : null
  if (!eventId) return
  const {workspaceId} = config
  verifyWorkspace()
  const handled = await handledEvent(repo.db, workspaceId, eventId)
  if (handled) return handled.id
  const iso = todayIso(new Date(eventTimestamp(event)))

  // Promotion INVENTS property names from message text (`key:: value`), so no
  // code seed can declare them. Mint their definitions BEFORE the write:
  // `addSchema` does its own writes and cannot run inside the tx below, and a
  // key that lands definition-less is skipped by property migration forever
  // (#501). Built out here so the same tree is registered and then written.
  const {tree: messageTree, diagnostics: promotionDiagnostics} =
    createBlocksFromEvent(event, matrixClient, repo)
  for (const note of promotionDiagnostics) console.warn('[matrix] promotion:', note)
  verifyWorkspace()
  const promotionNotes = await ensurePromotedPropertySchemas(repo, flattenBlockDefs(messageTree))
  for (const note of promotionNotes) console.warn('[matrix] promoted property:', note)

  return repo.tx(async (tx: Tx) => {
    const arrived = await handledEvent(tx.readDb, workspaceId, eventId)
    if (arrived) return arrived.id
    verifyWorkspace()
    const dailyId = await getOrCreateDailyNoteInTx(tx, repo.snapshotTypeRegistries(), workspaceId, iso)
    const tagBlockId = await ensureMatrixTagBlock(tx, workspaceId, dailyId, iso, verifyWorkspace)
    const lastChild = await tx.readDb.getOptional<{order_key: string}>(
      'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key DESC, id DESC LIMIT 1',
      [tagBlockId],
    )

    await createBlockTree(
      checkedTreeWriter(tx, verifyWorkspace),
      workspaceId,
      tagBlockId,
      messageTree,
      keysBetween(lastChild?.order_key ?? null, null, messageTree.length),
      eventId,
      {
        [eventIdProp.name]: eventId,
        [eventRoomProp.name]: config.roomId,
        [eventUrlProp.name]: matrixEventUrl(config.roomId, eventId),
        [eventAuthorProp.name]: typeof event.sender === 'string' ? event.sender : '',
        [eventTimestampProp.name]: eventTimestamp(event),
      },
    )
    return messageNodeId(workspaceId, eventId, [0])
  }, {scope: ChangeScope.BlockDefault, description: 'matrix message ingest'})
}

// ---------------------------------------------------------------------------
// one-time migration: rename legacy `matrix:*` event metadata onto the
// reserved `matrix-event:*` namespace. Runs once per workspace, scoped to the
// active workspace, idempotent (per-row recheck + localStorage marker). The
// discriminator is the camelCased `matrix:eventId`, which only the ingest sets
// — content promotion lowercases keys, so it can never produce it.

const migrationFlagKey = (workspaceId: string) => `${MIGRATION_FLAG_PREFIX}:${workspaceId}`

const migrateEventNamespace = async (repo: any): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId || repo.isReadOnly) return
  if (window.localStorage.getItem(migrationFlagKey(workspaceId))) return

  // Candidate roots: carry the legacy key but not the new one yet. The JSON
  // paths are fixed literals (no user input), so inlining them is safe.
  const candidates = await repo.db.getAll(
    `SELECT id FROM blocks
       WHERE workspace_id = ?
         AND deleted = 0
         AND json_extract(properties_json, '$."matrix:eventId"') IS NOT NULL
         AND json_extract(properties_json, '$."matrix-event:id"') IS NULL`,
    [workspaceId],
  ) as Array<{id: string}>

  const BATCH = 200
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    await repo.tx(async (tx: any) => {
      for (const {id} of batch) {
        const block = await tx.get(id)
        if (!block || block.deleted) continue
        // Re-check inside the tx — a concurrent ingest may have raced us.
        if (block.properties['matrix:eventId'] === undefined) continue
        if (block.properties[eventIdProp.name] !== undefined) continue

        const next: Record<string, unknown> = {...block.properties}
        for (const [oldKey, newKey] of EVENT_KEY_RENAMES) {
          if (!(oldKey in next)) continue
          if (!(newKey in next)) next[newKey] = next[oldKey]
          delete next[oldKey]
        }
        await tx.update(id, {properties: addBlockTypeToProperties(next, MATRIX_MESSAGE_TYPE)})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'matrix: migrate event metadata namespace'})
  }

  window.localStorage.setItem(migrationFlagKey(workspaceId), new Date().toISOString())
  if (candidates.length > 0) {
    showInfo(`Matrix: migrated ${candidates.length} message(s) to the matrix-event namespace.`)
  }
}

// ---------------------------------------------------------------------------
// one-time carry-over from the pre-refactor `.js`, which kept homeserver /
// room / autoStart / token together in a single localStorage JSON blob. The
// token can't move into the now-synced prefs block, so it gets its own
// localStorage key (shape change → migration); the rest seeds the prefs block.
// Per-device (the source is localStorage), idempotent via a flag, and it never
// clobbers a token or config the user has already set on this device/workspace.

const readLegacyConfig = () => {
  try {
    return JSON.parse(window.localStorage.getItem(LEGACY_CONFIG_KEY) ?? 'null')
  } catch {
    return null
  }
}

const migrateLegacyConfig = async (repo: any): Promise<void> => {
  if (window.localStorage.getItem(LEGACY_CONFIG_FLAG)) return
  const legacy = readLegacyConfig()
  if (legacy && typeof legacy === 'object') {
    if (typeof legacy.accessToken === 'string' && legacy.accessToken && !pendingToken()) {
      window.localStorage.setItem(LEGACY_TOKEN_KEY, legacy.accessToken)
    }
    // Seed the prefs block only when this workspace was never configured
    // (empty roomId), so a fresh config on this workspace is never stomped.
    const prefs = await prefsBlock(repo)
    if (prefs && !prefs.get(roomIdProp)) {
      if (typeof legacy.baseUrl === 'string' && legacy.baseUrl) {
        await prefs.set(homeserverProp, legacy.baseUrl)
      }
      if (typeof legacy.roomId === 'string' && legacy.roomId) {
        await prefs.set(roomIdProp, legacy.roomId)
      }
      if (typeof legacy.autoStart === 'boolean') {
        await prefs.set(autoStartProp, legacy.autoStart)
      }
    }
  }

  window.localStorage.setItem(LEGACY_CONFIG_FLAG, new Date().toISOString())
}

// ---------------------------------------------------------------------------
// poll loop

// Transient failures clear on the next poll, so they should stay out of the
// user's face — log them, reflect them in diagnostics, but don't toast.
// This covers network blips (fetch rejects with a TypeError; matrix-js-sdk may
// rewrap it as a ConnectionError) and server-side conditions that the
// long-poll naturally rides out (429 rate-limit, 5xx). Actionable errors —
// a bad/expired token, a malformed request — fall through to the loud path.
const RETRYABLE_MESSAGE_RE = /failed to fetch|fetch failed|network ?error|load failed/i

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true
  const name = (error as {name?: unknown})?.name
  if (name === 'ConnectionError' || name === 'AbortError') return true
  const status = (error as {httpStatus?: unknown})?.httpStatus
  if (typeof status === 'number') return status === 429 || status >= 500
  const message = error instanceof Error ? error.message : String(error)
  return RETRYABLE_MESSAGE_RE.test(message)
}

export const pollLoop = async (repo: any, config: MatrixConfig, signal: AbortSignal, matrixClient: any): Promise<void> => {
  let nextBatch = repo.localOnly ? loadNextBatch(config) : null
  const processed = new Set<string>()
  // `toasted` gates the one-per-streak toast (loud, actionable errors only);
  // `degraded` tracks whether a warning is currently shown so recovery clears it.
  let toasted = false
  let degraded = false
  clearMatrixDiagnostic()

  const stopped = new Error('Matrix poll stopped')
  const isCurrent = () => !signal.aborted && repo.activeWorkspaceId === config.workspaceId
  const verifyWorkspace = () => {
    if (!isCurrent()) throw stopped
  }
  while (isCurrent()) {
    try {
      nextBatch ??= checkpointPosition(await repo.load(checkpointId(config)), config)
      verifyWorkspace()
      const syncBody = await fetchMatrixSync(config, nextBatch, signal, matrixClient)
      const timeline = syncBody?.rooms?.join?.[config.roomId]?.timeline
      if (timeline && !Array.isArray(timeline.events)) throw new Error('Matrix timeline has no events array')
      const newBatch = syncPosition(syncBody)
      // With no prev_batch, page from this sync's upper bound. The overlap
      // with its timeline is safe because each message is checked by identity.
      const gap = timeline?.limited
        ? await fetchGapEvents(config, timeline.prev_batch === undefined ? newBatch : timeline.prev_batch, nextBatch, signal, matrixClient, verifyWorkspace)
        : null
      for (const batch of [gap ?? [], timeline?.events ?? []]) {
        for (const event of batch) {
          if (event?.type === 'm.room.message') {
            const root = await appendMatrixMessage(repo, config, event, matrixClient, verifyWorkspace)
            if (root && !repo.localOnly) processed.add(root)
          }
        }
      }

      if (processed.size && await writeCheckpoint(repo, config, newBatch, {processed}, verifyWorkspace)) {
        processed.clear()
      }
      verifyWorkspace()
      saveNextBatch(config, newBatch)
      nextBatch = newBatch
      if (gap) setMatrixDiagnostic({
        severity: 'ok', summary: 'Matrix history gap recovered',
        detail: `History events checked: ${gap.length}.`,
      })
      if (degraded) {
        degraded = false
        toasted = false
        if (!gap) clearMatrixDiagnostic()
      }
    } catch (error) {
      if (error === stopped || !isCurrent()) return
      const message = error instanceof Error ? error.message : String(error)
      degraded = true
      if (isRetryableError(error)) {
        console.warn('[matrix-messages] transient poll error (will retry):', message)
        setMatrixDiagnostic(retryErrorMatrixDiagnostic(message))
      } else {
        console.error('[matrix-messages]', error)
        setMatrixDiagnostic(hardErrorMatrixDiagnostic(message))
        // One toast per failure streak — a long-poll can fail every few
        // seconds and we don't want to bury the user in toasts.
        if (!toasted) {
          toasted = true
          showError(`Matrix ingest error: ${message}`)
        }
      }
      await abortableSleep(POLL_ERROR_DELAY_MS, signal).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// background effect — owns the poll lifecycle. No window-global singleton:
// the effect runtime calls our cleanup on hot-reload / disable, and we abort
// the in-flight poll there.

export const matrixIngestEffect = {
  id: 'matrix-chat-client.ingest',
  start: ({repo}: {repo: any}) => {
    let currentAbort: AbortController | null = null
    let unsubscribePrefs = () => {}
    let workspaceId: string | null = null
    let generation = 0
    let cancelled = false

    const stop = () => {
      generation++
      unsubscribePrefs()
      currentAbort?.abort()
    }

    const startPoll = () => {
      stop()
      if (cancelled) return
      workspaceId = repo.activeWorkspaceId
      const started = generation
      if (!workspaceId) {
        clearMatrixDiagnostic()
        return
      }

      const prefs: Block = repo.block(pluginPrefsBlockId(workspaceId, repo.user.id, matrixChatPrefsType.id))
      let previousFingerprint: string | undefined
      const refresh = () => {
        if (started !== generation) return
        const config = prefs.peek() ? loadConfig(prefs) : null
        const fingerprint = JSON.stringify(config)
        if (fingerprint === previousFingerprint) return
        previousFingerprint = fingerprint
        currentAbort?.abort()
        if (!config) {
          setMatrixDiagnostic(unconfiguredMatrixDiagnostic)
          return
        }
        if (!config.autoStart) {
          clearMatrixDiagnostic()
          return
        }
        if (!config.baseUrl || !config.roomId) {
          setMatrixDiagnostic(unconfiguredMatrixDiagnostic)
          return
        }
        if (!config.accessToken) {
          setMatrixDiagnostic(missingTokenMatrixDiagnostic)
          return
        }
        const activeConfig = {...config, accessToken: config.accessToken}
        const abort = new AbortController()
        currentAbort = abort
        void pollLoop(repo, activeConfig, abort.signal, createMatrixClient(activeConfig)).catch(error => {
          if (!abort.signal.aborted) console.error('[matrix-messages]', error)
        })
      }

      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith(TOKEN_PREFIX) || event.key.startsWith(STOPPED_PREFIX)) refresh()
      }
      window.addEventListener('storage', onStorage)
      const unsubscribeBlock = prefs.subscribe(refresh)
      unsubscribePrefs = () => {
        unsubscribeBlock()
        window.removeEventListener('storage', onStorage)
      }
      void prefs.load().then(refresh, error => {
        if (started === generation) setMatrixDiagnostic(hardErrorMatrixDiagnostic(String(error)))
      })
    }

    const unsubscribe = repo.client.onActingAsChange(() => {
      if (repo.activeWorkspaceId !== workspaceId) startPoll()
    })
    window.addEventListener(RESTART_EVENT, startPoll)

    void (async () => {
      try {
        await migrateLegacyConfig(repo)
      } catch (error) {
        console.error('[matrix-messages] legacy-config migration', error)
      }
      try {
        await migrateEventNamespace(repo)
      } catch (error) {
        console.error('[matrix-messages] migration', error)
      }
      startPoll()
    })()

    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener(RESTART_EVENT, startPoll)
      stop()
    }
  },
}

const requestRestart = () => window.dispatchEvent(new CustomEvent(RESTART_EVENT))

// ---------------------------------------------------------------------------
// setup dialog (homeserver / room / token)

const MatrixSetupDialog = () => {
  const repo = useRepo()
  const open = useSyncExternalStore(subscribeSetupOpen, () => setupOpen)
  const [homeserver, setHomeserver] = useState('https://matrix.org')
  const [roomId, setRoomId] = useState('')
  const [token, setToken] = useState('')
  const [workspace, setWorkspace] = useState<{id: string, name: string} | null>(null)
  const [saving, setSaving] = useState(false)

  // Load current prefs into the form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setToken('')
    setWorkspace(null)
    let cancelled = false
    void (async () => {
      try {
        const prefs = await prefsBlock(repo)
        if (!prefs) return
        const id = prefs.data.workspaceId
        const row = await repo.db.getOptional<{name: string}>('SELECT name FROM workspaces WHERE id = ?', [id])
        if (!row) throw new Error('Missing workspace')
        if (!cancelled) {
          setWorkspace({id, name: row.name})
          setHomeserver(prefs.get(homeserverProp) || 'https://matrix.org')
          setRoomId(prefs.get(roomIdProp) || '')
        }
      } catch {
        if (!cancelled) showError('Could not load Matrix settings.')
      }
    })()
    return () => { cancelled = true }
  }, [open, repo])

  const url = httpsUrl(homeserver)
  const baseUrl = originWithoutPath(url)
  const destination = workspace && baseUrl && roomId.trim()
    ? {workspaceId: workspace.id, baseUrl, roomId: roomId.trim()} : null
  const save = async (bindPending: boolean) => {
    setSaving(true)
    try {
      if (!destination || destination.workspaceId !== repo.activeWorkspaceId) {
        showError('Choose an HTTPS homeserver and room in the active workspace.')
        return
      }
      const prefs = await getPluginPrefsBlock(repo, destination.workspaceId, repo.user, matrixChatPrefsType)
      const selectedToken = bindPending ? eligibleLegacyToken(destination) : token
      if (!selectedToken && (bindPending || !loadToken(destination))) {
        showError('An access token is required.')
        return
      }
      await repo.tx(async tx => {
        await tx.setProperty(prefs.id, homeserverProp, baseUrl)
        await tx.setProperty(prefs.id, roomIdProp, destination.roomId)
        await tx.setProperty(prefs.id, autoStartProp, true)
      }, {scope: ChangeScope.BlockDefault, description: 'configure Matrix ingest'})
      await prefs.set(connectedHintProp, true)
      if (repo.activeWorkspaceId !== destination.workspaceId) throw new Error('The active workspace changed. Reopen Matrix settings.')
      if (bindPending && eligibleLegacyToken(destination) !== selectedToken) throw new Error('The saved device token changed. Reopen Matrix settings.')
      if (selectedToken) bindToken(destination, selectedToken)
      requestRestart()
      showSuccess('Matrix connected.')
      setSetupOpen(false)
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setSetupOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Matrix</DialogTitle>
          <DialogDescription>
            Point at your homeserver and the room to ingest, then paste an access token.
            The token is stored locally and never synced.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-homeserver'>Homeserver URL</Label>
            <Input
              id='mx-homeserver'
              value={homeserver}
              onChange={e => setHomeserver(e.target.value)}
              disabled={saving}
              placeholder='https://matrix.org'
            />
            {homeserver && !url && <span>Enter an HTTPS homeserver URL.</span>}
            {url && !baseUrl && <span>Enter the homeserver origin without a path.</span>}
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-room'>Room ID</Label>
            <Input
              id='mx-room'
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              disabled={saving}
              placeholder='!roomid:matrix.org'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-token'>Access token</Label>
            <Input
              id='mx-token'
              value={token}
              onChange={e => setToken(e.target.value)}
              disabled={saving}
              type='password'
              placeholder={destination && loadToken(destination) ? 'leave blank to keep saved token' : 'paste token'}
            />
          </div>
          {destination && workspace && <p className="break-all">Destination: {destination.baseUrl} · {destination.roomId} · workspace {workspace.name}</p>}
        </div>
        {pendingToken() && <p>Binding or saving a token clears the old unscoped credentials on this device.</p>}
        <Button variant='ghost' disabled={saving} onClick={forgetDeviceTokens}>Forget all Matrix tokens on this device</Button>
        <DialogFooter>
          <Button variant='ghost' onClick={() => setSetupOpen(false)} disabled={saving}>Cancel</Button>
          {open && destination && !token && eligibleLegacyToken(destination) && (
            <Button variant='outline' disabled={saving} onClick={() => void save(true)}>
              Bind saved device token
            </Button>
          )}
          <Button onClick={() => void save(false)} disabled={!destination || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// property editors (rendered on the prefs block's property panel)

const subscribeCredential = (notify: () => void) => {
  window.addEventListener(RESTART_EVENT, notify)
  window.addEventListener('storage', notify)
  return () => {
    window.removeEventListener(RESTART_EVENT, notify)
    window.removeEventListener('storage', notify)
  }
}

const resumeDevice = (destination: MatrixDestination) => {
  window.localStorage.removeItem(stoppedKey(destination))
  requestRestart()
}

const ConnectedEditor = ({value, onChange, block}: PropertyEditorProps<boolean>) => {
  const prefs = block as Block
  const destination = useHandle(prefs) && destinationFromPrefs(prefs)
  const tokenPresent = useSyncExternalStore(subscribeCredential, () => Boolean(destination && loadToken(destination)))
  const connected = value && destination && tokenPresent
  return (
    <div className='flex items-center gap-2'>
      <span>{connected ? 'Connected ✓' : 'Not connected'}</span>
      {connected
        ? (
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              window.localStorage.removeItem(tokenKey(destination))
              onChange(false)
              requestRestart()
              showInfo('Matrix disconnected.')
            }}
          >Disconnect</Button>
          )
        : (
          <Button
            size='sm'
            onClick={() => setSetupOpen(true)}
          >Connect…</Button>
          )}
      <Button
        variant='outline'
        size='sm'
        onClick={() => resumeDevice(destinationFromPrefs(prefs))}
        disabled={!tokenPresent}
      >Restart ingest</Button>
    </div>
  )
}

const connectedEditor = definePropertyEditorOverride(connectedHintProp, {
  label: 'Matrix',
  Editor: ConnectedEditor,
})
const homeserverEditor = definePropertyEditorOverride(homeserverProp, {
  label: 'Homeserver URL',
})
const roomIdEditor = definePropertyEditorOverride(roomIdProp, {
  label: 'Room ID',
})
const autoStartEditor = definePropertyEditorOverride(autoStartProp, {
  label: 'Auto-start ingest',
})

// ---------------------------------------------------------------------------
// actions

const openSettingsAction = {
  id: 'matrix.configure',
  description: 'Matrix: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, matrixChatPrefsType)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefs.id, workspaceId})
  },
}

const connectAction = {
  id: 'matrix.connect',
  description: 'Matrix: connect / change token',
  context: ActionContextTypes.GLOBAL,
  handler: () => { setSetupOpen(true) },
}

const startAction = {
  id: 'matrix.start',
  description: 'Matrix: start message ingest',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const prefs = await prefsBlock(uiStateBlock.repo)
    if (!prefs) return
    const destination = destinationFromPrefs(prefs)
    await prefs.set(autoStartProp, true)
    resumeDevice(destination)
  },
}

const stopAction = {
  id: 'matrix.stop',
  description: 'Matrix: stop message ingest on this device',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const prefs = await prefsBlock(uiStateBlock.repo)
    if (!prefs) return
    window.localStorage.setItem(stoppedKey(destinationFromPrefs(prefs)), '1')
    requestRestart()
  },
}

const initializePositionAction = (fresh: boolean) => ({
  id: fresh ? 'matrix.reset-position' : 'matrix.publish-position',
  description: fresh ? 'Matrix: Start fresh from now (new room)' : 'Matrix: publish this writer’s saved position',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const repo = uiStateBlock.repo
    const prefs = await prefsBlock(repo)
    if (!prefs) return
    const candidate = loadConfig(prefs)
    if (!candidate.accessToken) {
      showError(missingTokenMatrixDiagnostic.detail!)
      return
    }
    const config = {...candidate, accessToken: candidate.accessToken}
    try {
      if (fresh) {
        if (!window.confirm('Start Matrix ingest from now? Earlier messages will be skipped.')) return
        await startFresh(repo, config, new AbortController().signal, createMatrixClient(config))
      } else {
        await publishDeviceCheckpoint(repo, config)
      }
      requestRestart()
      showSuccess('Matrix room checkpoint created.')
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    }
  },
})

// ---------------------------------------------------------------------------
// audio-url content decorator — a message carrying a `matrix:audio-url`
// property (promoted from an `audio-url::` attribute in the message body) gets
// a small audio glyph pinned to its top-right corner that opens the linked
// audio in a new tab. A decorator (not a renderer override) so it composes with
// whatever content renderer the block already uses — same idiom as the geo /
// character-counter / readwise decorators. Gated on the stable `matrix-message`
// type membership (resolver context doesn't track property changes); the icon
// itself is shown/hidden inside the component from a reactive `useHandle` read,
// so it appears the moment the property lands and vanishes if it's cleared.

const AUDIO_URL_KEY = 'matrix:audio-url'

// The property is promoted from message *content* (external, untrusted), so
// only honour http(s) URLs before placing one in an <a href> — never let a
// `javascript:`/`data:` value through. A multi-valued promotion arrives as an
// array; take the first usable entry.
const firstHttpUrl = (value: unknown): string | null => {
  const candidates = Array.isArray(value) ? value : [value]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
  }
  return null
}

const matrixAudioLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '22px',
  height: '22px',
  borderRadius: '4px',
  color: 'var(--muted-foreground)',
  background: 'var(--background)',
  cursor: 'pointer',
  textDecoration: 'none',
}

// lucide `audio-lines` glyph, inlined to avoid a runtime dependency import.
const AudioGlyph = () => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    width='16'
    height='16'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='2'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
  >
    <path d='M2 10v3'/>
    <path d='M6 6v11'/>
    <path d='M10 3v18'/>
    <path d='M14 8v7'/>
    <path d='M18 5v13'/>
    <path d='M22 10v3'/>
  </svg>
)

const MatrixAudioLink: BlockRenderer = ({block}) => {
  const audioUrl = useHandle(block, {
    selector: data => firstHttpUrl(data?.properties?.[AUDIO_URL_KEY]),
  })
  if (!audioUrl) return null
  return (
    <a
      href={audioUrl}
      target='_blank'
      rel='noreferrer'
      title='Open audio'
      aria-label='Open audio'
      style={matrixAudioLinkStyle}
      onClick={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
    >
      <AudioGlyph/>
    </a>
  )
}

const matrixAudioItem: BlockGutterItem = {corner: 'top-right', component: MatrixAudioLink}

const matrixAudioGutterItem: BlockGutterItemContribution = ctx =>
  ctx.types.includes(MATRIX_MESSAGE_TYPE) ? matrixAudioItem : null

// ---------------------------------------------------------------------------
// wiring

export default [
  typeSeedsFacet.of(matrixChatPrefsType, {source}),
  typeSeedsFacet.of(matrixMessageType, {source}),
  typeSeedsFacet.of(checkpointType, {source}),
  definitionSeedsFacet.of(checkpointProp, {source}),

  definitionSeedsFacet.of(homeserverProp, {source}),
  definitionSeedsFacet.of(roomIdProp, {source}),
  definitionSeedsFacet.of(autoStartProp, {source}),
  definitionSeedsFacet.of(connectedHintProp, {source}),
  definitionSeedsFacet.of(eventIdProp, {source}),
  definitionSeedsFacet.of(eventRoomProp, {source}),
  definitionSeedsFacet.of(eventUrlProp, {source}),
  definitionSeedsFacet.of(eventAuthorProp, {source}),
  definitionSeedsFacet.of(eventTimestampProp, {source}),

  propertyEditorOverridesFacet.of(connectedEditor, {source}),
  propertyEditorOverridesFacet.of(homeserverEditor, {source}),
  propertyEditorOverridesFacet.of(roomIdEditor, {source}),
  propertyEditorOverridesFacet.of(autoStartEditor, {source}),

  diagnosticsFacet.of(matrixDiagnosticSource, {source}),

  appMountsFacet.of({id: 'matrix.setup-dialog', component: MatrixSetupDialog}, {source}),
  appEffectsFacet.of(matrixIngestEffect, {source}),

  blockGutterItemsFacet.of(matrixAudioGutterItem, {source}),

  actionsFacet.of(openSettingsAction, {source}),
  actionsFacet.of(connectAction, {source}),
  actionsFacet.of(startAction, {source}),
  actionsFacet.of(stopAction, {source}),
  actionsFacet.of(initializePositionAction(false), {source}),
  actionsFacet.of(initializePositionAction(true), {source}),
]
