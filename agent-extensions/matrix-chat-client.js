import {
  ActionContextTypes,
  ChangeScope,
  actionsFacet,
} from '@/extensions/api.js'
import {
  dailyNoteBlockId,
  getOrCreateDailyNote,
  todayIso,
} from '@/data/dailyNotes.js'
import { keyAtEnd } from '@/data/internals/orderKey.js'

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

const buildSyncUrl = (config, since) => {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/_matrix/client/v3/sync`)
  url.searchParams.set('timeout', since ? '30000' : '0')
  if (since) url.searchParams.set('since', since)
  url.searchParams.set('filter', JSON.stringify({
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
  }))
  return url
}

const fetchMatrixSync = async (config, since, signal) => {
  const response = await window.fetch(buildSyncUrl(config, since), {
    headers: {
      authorization: `Bearer ${config.accessToken}`,
    },
    signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Matrix sync failed with ${response.status}: ${body.slice(0, 240)}`)
  }

  return response.json()
}

const roomEventsFromSync = (syncBody, roomId) => {
  const events = syncBody?.rooms?.join?.[roomId]?.timeline?.events
  return Array.isArray(events) ? events : []
}

const eventTimestamp = event => {
  const ts = event?.origin_server_ts
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now()
}

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim()

const formatMessageContent = event => {
  const content = event.content && typeof event.content === 'object' ? event.content : {}
  const sender = oneLine(event.sender || 'unknown')
  const body = oneLine(content.body || content.url || '')
  const msgtype = oneLine(content.msgtype || 'm.room.message')
  const stamp = new Date(eventTimestamp(event)).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  if (msgtype === 'm.emote') return `[${stamp}] * ${sender} ${body}`
  if (msgtype !== 'm.text' && msgtype !== 'm.notice') {
    return `[${stamp}] ${sender} (${msgtype}): ${body}`
  }
  return `[${stamp}] ${sender}: ${body}`
}

const appendMatrixMessage = async (repo, config, event) => {
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

    await tx.create({
      workspaceId,
      parentId: tagBlockId,
      orderKey: keyAtEnd(messageChildren.at(-1)?.orderKey ?? null),
      content: formatMessageContent(event),
      properties: {
        'matrix:eventId': eventId,
        'matrix:roomId': config.roomId,
        'matrix:sender': typeof event.sender === 'string' ? event.sender : '',
        'matrix:originServerTs': eventTimestamp(event),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'matrix message ingest'})
}

const createManager = () => ({
  version: VERSION,
  abortController: null,
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
    this.abortController = abortController
    this.status = 'running'
    this.lastError = null

    void pollLoop(repo, config, abortController.signal, this)
    return true
  },

  stop() {
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

const pollLoop = async (repo, config, signal, runtime) => {
  let nextBatch = loadNextBatch(config)

  while (!signal.aborted) {
    try {
      const syncBody = await fetchMatrixSync(config, nextBatch, signal)
      const events = nextBatch ? roomEventsFromSync(syncBody, config.roomId) : []

      for (const event of events) {
        if (event?.type !== 'm.room.message') continue
        await appendMatrixMessage(repo, config, event)
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

export default (context) => {
  const runtime = manager()
  const config = loadConfig()
  if (config?.autoStart) runtime.start(context.repo)

  return [
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
}
