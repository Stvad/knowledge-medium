import {
  ActionContextTypes,
  ChangeScope,
  actionsFacet,
  appEffectsFacet,
} from '@/extensions/api.js'
import {
  dailyNoteBlockId,
  getOrCreateDailyNote,
  todayIso,
} from '@/data/dailyNotes.js'
import { keyAtEnd, keysBetween } from '@/data/internals/orderKey.js'
import * as matrixSdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle'

const VERSION = 1
const GLOBAL_KEY = '__knowledgeMediumMatrixMessages'
const CONFIG_KEY = 'knowledge-medium:matrix-messages:config:v1'
const STATE_KEY_PREFIX = 'knowledge-medium:matrix-messages:state:v1'
const TAG_BLOCK_CONTENT = '[[matrix-messages]]'
const POLL_ERROR_DELAY_MS = 5_000

const normalizeBaseUrl = value => value.replace(/\/+$/, '')

const readJson = (key) => {
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const writeJson = (key, value) => {
  window.localStorage.setItem(key, JSON.stringify(value))
}

const loadConfig = () => {
  const config = readJson(CONFIG_KEY)
  if (!config || typeof config !== 'object') return null
  if (typeof config.baseUrl !== 'string') return null
  if (typeof config.roomId !== 'string') return null
  if (typeof config.accessToken !== 'string') return null
  if (!config.baseUrl || !config.roomId || !config.accessToken) return null
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    roomId: config.roomId,
    accessToken: config.accessToken,
    autoStart: config.autoStart !== false,
  }
}

const saveConfig = config => {
  writeJson(CONFIG_KEY, {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    roomId: config.roomId,
    accessToken: config.accessToken,
    autoStart: config.autoStart !== false,
  })
}

const stateKey = config =>
  `${STATE_KEY_PREFIX}:${normalizeBaseUrl(config.baseUrl)}:${config.roomId}`

const loadNextBatch = config => {
  const state = readJson(stateKey(config))
  return typeof state?.nextBatch === 'string' ? state.nextBatch : null
}

const saveNextBatch = (config, nextBatch) => {
  writeJson(stateKey(config), {nextBatch, savedAt: Date.now()})
}

const clearNextBatch = config => {
  window.localStorage.removeItem(stateKey(config))
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timeout = window.setTimeout(resolve, ms)
  signal.addEventListener('abort', () => {
    window.clearTimeout(timeout)
    reject(new DOMException('Aborted', 'AbortError'))
  }, {once: true})
})

const syncFilter = config => ({
  room: {
    rooms: [config.roomId],
    timeline: {
      types: ['m.room.message'],
      limit: 30,
    },
    state: {types: []},
    ephemeral: {types: []},
    account_data: {types: []},
  },
  presence: {types: []},
  account_data: {types: []},
})

const buildSyncQueryParams = (config, since) => {
  const queryParams = {
    timeout: since ? '30000' : '0',
    filter: JSON.stringify(syncFilter(config)),
  }
  if (since) queryParams.since = since
  return queryParams
}

const createMatrixClient = config =>
  matrixSdk.createClient({
    baseUrl: normalizeBaseUrl(config.baseUrl),
    accessToken: config.accessToken,
  })

const fetchMatrixSync = (config, since, signal, matrixClient) =>
  matrixClient.http.authedRequest(
    'GET',
    '/sync',
    buildSyncQueryParams(config, since),
    undefined,
    {abortSignal: signal},
  )

const roomEventsFromSync = (syncBody, roomId) => {
  const events = syncBody?.rooms?.join?.[roomId]?.timeline?.events
  return Array.isArray(events) ? events : []
}

const eventTimestamp = event => {
  const ts = event?.origin_server_ts
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now()
}

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const unwrapLinks = value => {
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

const mxcToHttpUrl = (mxcUrl, matrixClient) => {
  if (typeof mxcUrl !== 'string' || !mxcUrl.startsWith('mxc://')) return mxcUrl || ''

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

const getMediaLabel = (content, fallback) =>
  String(content.body || content.filename || fallback).trim() || fallback

const getMessageText = (event, matrixClient) => {
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

const parseMarkdownToBlockDefinitions = markdownText => {
  const source = String(markdownText ?? '')
  const lines = source.split(/\r?\n/).filter(line => line.trim() !== '')
  const blocks = parseLines([...lines])
  return blocks && blocks.length ? blocks : [{content: source.trim() || '(empty message)'}]
}

const parseLines = (lines, level = 0) => {
  const blocks = []

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

const isListItem = line => /^(\s*)-\s+/.test(line)

const parseListItem = line => {
  const listItemMatch = line.match(/^(\s*)-\s+(.*)/)
  if (!listItemMatch) throw new Error('Invalid list item format')
  return {
    leadingSpaces: listItemMatch[1].length,
    content: listItemMatch[2],
  }
}

const isValidIndentation = spaces => spaces % 2 === 0

const appendContinuationLine = (block, line) => {
  block.content += `\n${line.trim()}`
}

const createBlocksFromEvent = (event, config, matrixClient) => {
  const text = getMessageText(event, matrixClient)
  const blocksFromText = parseMarkdownToBlockDefinitions(text)
  const metadataBlock = {
    content: `URL::https://matrix.to/#/${config.roomId}/${event.event_id}`,
  }

  const lastBlock = blocksFromText[blocksFromText.length - 1]
  lastBlock.children = [...(lastBlock.children ?? []), metadataBlock]
  return blocksFromText
}

const createBlockTree = async (tx, workspaceId, parentId, blockDefinitions, rootProperties) => {
  if (!blockDefinitions.length) return

  const existingChildren = await tx.childrenOf(parentId, workspaceId)
  const orderKeys = keysBetween(
    existingChildren.at(-1)?.orderKey ?? null,
    null,
    blockDefinitions.length,
  )

  for (const [index, block] of blockDefinitions.entries()) {
    const id = await tx.create({
      workspaceId,
      parentId,
      orderKey: orderKeys[index],
      content: block.content,
      properties: index === 0 && rootProperties ? rootProperties : undefined,
    })

    if (Array.isArray(block.children) && block.children.length) {
      await createBlockTree(tx, workspaceId, id, block.children)
    }
  }
}

const appendMatrixMessage = async (repo, config, event, matrixClient) => {
  const eventId = typeof event.event_id === 'string' ? event.event_id : null
  if (!eventId) return

  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('Matrix message ingest requires an active workspace')

  const iso = todayIso(new Date(eventTimestamp(event)))
  await getOrCreateDailyNote(repo, workspaceId, iso)
  const dailyId = dailyNoteBlockId(workspaceId, iso)

  await repo.tx(async tx => {
    const dailyChildren = await tx.childrenOf(dailyId, workspaceId)
    let tagBlock = dailyChildren.find(child => child.content.trim() === TAG_BLOCK_CONTENT)
    let tagBlockId = tagBlock?.id

    if (!tagBlockId) {
      tagBlockId = await tx.create({
        workspaceId,
        parentId: dailyId,
        orderKey: keyAtEnd(dailyChildren.at(-1)?.orderKey ?? null),
        content: TAG_BLOCK_CONTENT,
      })
    }

    const messageChildren = await tx.childrenOf(tagBlockId, workspaceId)
    const alreadyPosted = messageChildren.some(child =>
      child.properties?.['matrix:eventId'] === eventId,
    )
    if (alreadyPosted) return

    await createBlockTree(
      tx,
      workspaceId,
      tagBlockId,
      createBlocksFromEvent(event, config, matrixClient),
      {
        'matrix:eventId': eventId,
        'matrix:roomId': config.roomId,
        'matrix:author': typeof event.sender === 'string' ? event.sender : '',
        'matrix:timestamp': eventTimestamp(event),
      },
    )
  }, {scope: ChangeScope.BlockDefault, description: 'matrix message ingest'})
}

const createManager = () => ({
  version: VERSION,
  abortController: null,
  matrixClient: null,
  status: 'stopped',
  lastError: null,

  start(repo) {
    const config = loadConfig()
    if (!config) {
      this.status = 'unconfigured'
      return false
    }

    this.stop()
    const abortController = new AbortController()
    const matrixClient = createMatrixClient(config)
    this.abortController = abortController
    this.matrixClient = matrixClient
    this.status = 'running'
    this.lastError = null

    void pollLoop(repo, config, abortController.signal, matrixClient, this)
    return true
  },

  stop() {
    this.matrixClient?.http?.abort?.()
    this.matrixClient?.stopClient?.()
    this.matrixClient = null
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.status !== 'unconfigured') this.status = 'stopped'
  },
})

const manager = () => {
  const existing = window[GLOBAL_KEY]
  if (existing?.version === VERSION) return existing
  existing?.stop?.()
  const next = createManager()
  window[GLOBAL_KEY] = next
  return next
}

const pollLoop = async (repo, config, signal, matrixClient, runtime) => {
  let nextBatch = loadNextBatch(config)

  while (!signal.aborted) {
    try {
      const syncBody = await fetchMatrixSync(config, nextBatch, signal, matrixClient)
      const events = nextBatch ? roomEventsFromSync(syncBody, config.roomId) : []

      for (const event of events) {
        if (event?.type !== 'm.room.message') continue
        await appendMatrixMessage(repo, config, event, matrixClient)
      }

      if (typeof syncBody?.next_batch === 'string') {
        nextBatch = syncBody.next_batch
        saveNextBatch(config, nextBatch)
      }
      runtime.status = 'running'
      runtime.lastError = null
    } catch (error) {
      if (signal.aborted) return
      runtime.status = 'error'
      runtime.lastError = error instanceof Error ? error.message : String(error)
      console.error('[matrix-messages]', error)
      await sleep(POLL_ERROR_DELAY_MS, signal).catch(() => undefined)
    }
  }
}

const configureFromPrompts = repo => {
  const current = loadConfig()
  const baseUrl = window.prompt('Matrix homeserver URL', current?.baseUrl || 'https://matrix.org')
  if (!baseUrl) return

  const roomId = window.prompt('Matrix room ID', current?.roomId || '')
  if (!roomId) return

  const tokenPrompt = current?.accessToken
    ? 'Matrix access token (leave blank to keep saved token)'
    : 'Matrix access token'
  const accessToken = window.prompt(tokenPrompt, '')
  const token = accessToken || current?.accessToken
  if (!token) return

  const next = {
    baseUrl: normalizeBaseUrl(baseUrl),
    roomId,
    accessToken: token,
    autoStart: true,
  }
  saveConfig(next)
  clearNextBatch(next)
  manager().start(repo)
}

const matrixMessageEffect = {
  id: 'user.matrix.poller',
  start: ({repo}) => {
    const runtime = manager()
    const config = loadConfig()
    if (config?.autoStart) runtime.start(repo)
    return () => runtime.stop()
  },
}

export default [
  appEffectsFacet.of(matrixMessageEffect, {source: 'matrix-chat-client'}),

  actionsFacet.of({
    id: 'user.matrix.configure',
    description: 'Configure Matrix message ingest',
    context: ActionContextTypes.GLOBAL,
    handler: async ({uiStateBlock}) => configureFromPrompts(uiStateBlock.repo),
  }, {source: 'matrix-chat-client'}),

  actionsFacet.of({
    id: 'user.matrix.start',
    description: 'Start Matrix message ingest',
    context: ActionContextTypes.GLOBAL,
    handler: async ({uiStateBlock}) => manager().start(uiStateBlock.repo),
  }, {source: 'matrix-chat-client'}),

  actionsFacet.of({
    id: 'user.matrix.stop',
    description: 'Stop Matrix message ingest',
    context: ActionContextTypes.GLOBAL,
    handler: async () => manager().stop(),
  }, {source: 'matrix-chat-client'}),

  actionsFacet.of({
    id: 'user.matrix.reset-position',
    description: 'Reset Matrix message ingest position',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      const config = loadConfig()
      if (config) clearNextBatch(config)
    },
  }, {source: 'matrix-chat-client'}),
]
