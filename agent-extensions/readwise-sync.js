import {
  ActionContextTypes,
  ChangeScope,
  actionsFacet,
  appEffectsFacet,
  codecs,
  defineProperty,
  propertySchemasFacet,
} from '@/extensions/api.js'
import { keyAtEnd, keysBetween } from '@/data/orderKey.js'

const VERSION = 1
const GLOBAL_KEY = '__knowledgeMediumReadwiseSync'
const CONFIG_KEY = 'knowledge-medium:readwise-sync:config:v1'
const STATE_KEY = 'knowledge-medium:readwise-sync:state:v1'
const ROOT_PAGE_TITLE = 'Readwise'
const EXPORT_ENDPOINT = 'https://readwise.io/api/v2/export/'
const DEFAULT_POLL_INTERVAL_MINUTES = 60
const MIN_POLL_INTERVAL_MINUTES = 5

const readwiseBookIdProp = defineProperty('readwise:book-id', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseHighlightIdProp = defineProperty('readwise:highlight-id', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseSourceProp = defineProperty('readwise:source', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseCategoryProp = defineProperty('readwise:category', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseAuthorProp = defineProperty('readwise:author', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseUrlProp = defineProperty('readwise:url', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseSourceUrlProp = defineProperty('readwise:source-url', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseUpdatedAtProp = defineProperty('readwise:updated-at', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseSyncedAtProp = defineProperty('readwise:synced-at', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseHighlightedAtProp = defineProperty('readwise:highlighted-at', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseLocationProp = defineProperty('readwise:location', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseLocationTypeProp = defineProperty('readwise:location-type', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseColorProp = defineProperty('readwise:color', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseNoteProp = defineProperty('readwise:note', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseTagsProp = defineProperty('readwise:tags', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const propertySchemas = [
  readwiseBookIdProp,
  readwiseHighlightIdProp,
  readwiseSourceProp,
  readwiseCategoryProp,
  readwiseAuthorProp,
  readwiseUrlProp,
  readwiseSourceUrlProp,
  readwiseUpdatedAtProp,
  readwiseSyncedAtProp,
  readwiseHighlightedAtProp,
  readwiseLocationProp,
  readwiseLocationTypeProp,
  readwiseColorProp,
  readwiseNoteProp,
  readwiseTagsProp,
]

const propertyByName = {
  'readwise:book-id': readwiseBookIdProp,
  'readwise:highlight-id': readwiseHighlightIdProp,
  'readwise:source': readwiseSourceProp,
  'readwise:category': readwiseCategoryProp,
  'readwise:author': readwiseAuthorProp,
  'readwise:url': readwiseUrlProp,
  'readwise:source-url': readwiseSourceUrlProp,
  'readwise:updated-at': readwiseUpdatedAtProp,
  'readwise:synced-at': readwiseSyncedAtProp,
  'readwise:highlighted-at': readwiseHighlightedAtProp,
  'readwise:location': readwiseLocationProp,
  'readwise:location-type': readwiseLocationTypeProp,
  'readwise:color': readwiseColorProp,
  'readwise:note': readwiseNoteProp,
  'readwise:tags': readwiseTagsProp,
}

const readJson = key => {
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

const removeJson = key => {
  window.localStorage.removeItem(key)
}

const clampPollInterval = value => {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return DEFAULT_POLL_INTERVAL_MINUTES
  return Math.max(MIN_POLL_INTERVAL_MINUTES, Math.round(minutes))
}

const normalizeIso = value => {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

const normalizeText = value => String(value ?? '').trim()

const loadConfig = () => {
  const config = readJson(CONFIG_KEY)
  if (!config || typeof config !== 'object') return null
  if (typeof config.accessToken !== 'string' || !config.accessToken.trim()) return null

  return {
    accessToken: config.accessToken,
    autoStart: config.autoStart === true,
    pollIntervalMinutes: clampPollInterval(config.pollIntervalMinutes),
    initialUpdatedAfter: normalizeIso(config.initialUpdatedAfter),
  }
}

const saveConfig = config => {
  writeJson(CONFIG_KEY, {
    accessToken: config.accessToken,
    autoStart: config.autoStart === true,
    pollIntervalMinutes: clampPollInterval(config.pollIntervalMinutes),
    initialUpdatedAfter: normalizeIso(config.initialUpdatedAfter),
  })
}

const loadState = () => {
  const state = readJson(STATE_KEY)
  return state && typeof state === 'object' ? state : {}
}

const saveState = state => {
  writeJson(STATE_KEY, state)
}

const exportUrl = (updatedAfter, pageCursor) => {
  const url = new URL(EXPORT_ENDPOINT)
  if (updatedAfter) url.searchParams.set('updatedAfter', updatedAfter)
  if (pageCursor) url.searchParams.set('pageCursor', pageCursor)
  return url
}

const fetchExportPage = async (config, updatedAfter, pageCursor, signal) => {
  const response = await fetch(exportUrl(updatedAfter, pageCursor), {
    signal,
    headers: {
      Authorization: `Token ${config.accessToken}`,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Readwise export failed (${response.status}): ${body || response.statusText}`)
  }

  const page = await response.json()
  const results = Array.isArray(page.results) ? page.results : []
  const nextPageCursor = typeof page.nextPageCursor === 'string'
    ? page.nextPageCursor
    : null

  return {results, nextPageCursor}
}

const fetchAllExportedBooks = async (config, updatedAfter, signal) => {
  const books = []
  let pageCursor = null

  do {
    const page = await fetchExportPage(config, updatedAfter, pageCursor, signal)
    books.push(...page.results)
    pageCursor = page.nextPageCursor
  } while (pageCursor && !signal.aborted)

  return books
}

const maxIso = (...values) => {
  let latest = null
  for (const value of values.flat()) {
    const iso = normalizeIso(value)
    if (!iso) continue
    if (!latest || Date.parse(iso) > Date.parse(latest)) latest = iso
  }
  return latest
}

const bookUpdatedAt = book => maxIso(
  book.updated,
  book.last_highlight_at,
  (Array.isArray(book.highlights) ? book.highlights : []).flatMap(highlight => [
    highlight.updated_at,
    highlight.highlighted_at,
  ]),
)

const tagsFrom = value => {
  if (!Array.isArray(value)) return []
  return value
    .map(tag => normalizeText(typeof tag === 'string' ? tag : tag?.name))
    .filter(Boolean)
}

const bookId = book => normalizeText(book.id ?? book.book_id)

const highlightId = highlight => normalizeText(highlight.id ?? highlight.highlight_id)

const bookContent = book => {
  const title = normalizeText(book.title) || 'Untitled Readwise item'
  const author = normalizeText(book.author)
  return author ? `${title} by ${author}` : title
}

const highlightContent = highlight =>
  normalizeText(highlight.text) || normalizeText(highlight.note) || '(empty Readwise highlight)'

const compactProperties = properties => Object.fromEntries(
  Object.entries(properties).filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false
    if (Array.isArray(value) && value.length === 0) return false
    return true
  }),
)

const bookProperties = (book, syncedAt) => compactProperties({
  'readwise:book-id': bookId(book),
  'readwise:source': normalizeText(book.source),
  'readwise:category': normalizeText(book.category),
  'readwise:author': normalizeText(book.author),
  'readwise:url': normalizeText(book.readwise_url),
  'readwise:source-url': normalizeText(book.source_url),
  'readwise:updated-at': bookUpdatedAt(book),
  'readwise:synced-at': syncedAt,
})

const highlightProperties = (book, highlight, syncedAt) => compactProperties({
  'readwise:book-id': bookId(book),
  'readwise:highlight-id': highlightId(highlight),
  'readwise:url': normalizeText(highlight.url),
  'readwise:source-url': normalizeText(book.source_url),
  'readwise:highlighted-at': normalizeIso(highlight.highlighted_at),
  'readwise:updated-at': normalizeIso(highlight.updated_at),
  'readwise:location': normalizeText(highlight.location),
  'readwise:location-type': normalizeText(highlight.location_type),
  'readwise:color': normalizeText(highlight.color),
  'readwise:note': normalizeText(highlight.note),
  'readwise:tags': tagsFrom(highlight.tags),
  'readwise:synced-at': syncedAt,
})

const findRootPage = async (tx, workspaceId) => {
  const roots = await tx.childrenOf(null, workspaceId)
  return roots.find(block => block.content.trim() === ROOT_PAGE_TITLE) ?? null
}

const ensureRootPage = async (tx, workspaceId) => {
  const existing = await findRootPage(tx, workspaceId)
  if (existing) return {id: existing.id, created: false}

  const roots = await tx.childrenOf(null, workspaceId)
  const id = await tx.create({
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(roots.at(-1)?.orderKey ?? null),
    content: ROOT_PAGE_TITLE,
    properties: {types: ['page']},
  })
  return {id, created: true}
}

const readBlockProperties = (repo, id) => repo.block(id).peek()?.properties ?? {}

const buildReadwiseIndex = async (repo, rootId) => {
  const subtree = await repo.query.subtree({id: rootId}).load()
  const books = new Map()
  const highlights = new Map()

  for (const row of subtree) {
    if (row.id === rootId) continue
    const properties = readBlockProperties(repo, row.id)
    const existingHighlightId = normalizeText(properties['readwise:highlight-id'])
    const existingBookId = normalizeText(properties['readwise:book-id'])

    if (existingHighlightId) {
      highlights.set(existingHighlightId, row.id)
    } else if (existingBookId) {
      books.set(existingBookId, row.id)
    }
  }

  return {books, highlights}
}

const setProperties = async (tx, blockId, properties) => {
  for (const [name, value] of Object.entries(properties)) {
    await tx.setProperty(blockId, propertyByName[name] ?? name, value)
  }
}

const createHighlightBlocks = async (tx, workspaceId, parentId, highlights, syncedAt, book, index) => {
  if (!highlights.length) return {created: 0, skipped: 0}

  const existingChildren = await tx.childrenOf(parentId, workspaceId)
  const orderKeys = keysBetween(
    existingChildren.at(-1)?.orderKey ?? null,
    null,
    highlights.length,
  )
  let created = 0
  let skipped = 0

  for (const [offset, highlight] of highlights.entries()) {
    const id = highlightId(highlight)
    if (!id) {
      skipped += 1
      continue
    }

    const existingHighlightId = index.highlights.get(id)
    if (existingHighlightId) {
      await setProperties(tx, existingHighlightId, highlightProperties(book, highlight, syncedAt))
      skipped += 1
      continue
    }

    const children = []
    const note = normalizeText(highlight.note)
    if (note) children.push({content: `Note: ${note}`})

    const highlightBlockId = await tx.create({
      workspaceId,
      parentId,
      orderKey: orderKeys[offset],
      content: highlightContent(highlight),
      properties: highlightProperties(book, highlight, syncedAt),
    })

    if (children.length) {
      await createBlockTree(tx, workspaceId, highlightBlockId, children)
    }

    index.highlights.set(id, highlightBlockId)
    created += 1
  }

  return {created, skipped}
}

const createBlockTree = async (tx, workspaceId, parentId, blocks) => {
  if (!blocks.length) return

  const existingChildren = await tx.childrenOf(parentId, workspaceId)
  const orderKeys = keysBetween(
    existingChildren.at(-1)?.orderKey ?? null,
    null,
    blocks.length,
  )

  for (const [index, block] of blocks.entries()) {
    const id = await tx.create({
      workspaceId,
      parentId,
      orderKey: orderKeys[index],
      content: block.content,
      properties: block.properties,
    })

    if (Array.isArray(block.children) && block.children.length) {
      await createBlockTree(tx, workspaceId, id, block.children)
    }
  }
}

const upsertBook = async (tx, workspaceId, rootId, book, syncedAt, index) => {
  const id = bookId(book)
  if (!id) return {booksCreated: 0, booksUpdated: 0, highlightsCreated: 0, highlightsSkipped: 0}

  let blockId = index.books.get(id)
  let booksCreated = 0
  let booksUpdated = 0

  if (!blockId) {
    const rootChildren = await tx.childrenOf(rootId, workspaceId)
    blockId = await tx.create({
      workspaceId,
      parentId: rootId,
      orderKey: keyAtEnd(rootChildren.at(-1)?.orderKey ?? null),
      content: bookContent(book),
      properties: bookProperties(book, syncedAt),
    })
    index.books.set(id, blockId)
    booksCreated = 1
  } else {
    await setProperties(tx, blockId, bookProperties(book, syncedAt))
    booksUpdated = 1
  }

  const highlights = Array.isArray(book.highlights) ? book.highlights : []
  const highlightStats = await createHighlightBlocks(
    tx,
    workspaceId,
    blockId,
    highlights,
    syncedAt,
    book,
    index,
  )

  return {
    booksCreated,
    booksUpdated,
    highlightsCreated: highlightStats.created,
    highlightsSkipped: highlightStats.skipped,
  }
}

const upsertBooks = async (repo, books) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('Readwise sync requires an active workspace')

  const syncedAt = new Date().toISOString()
  const totals = {
    booksCreated: 0,
    booksUpdated: 0,
    highlightsCreated: 0,
    highlightsSkipped: 0,
  }

  await repo.tx(async tx => {
    const root = await ensureRootPage(tx, workspaceId)
    const index = root.created
      ? {books: new Map(), highlights: new Map()}
      : await buildReadwiseIndex(repo, root.id)

    for (const book of books) {
      const result = await upsertBook(tx, workspaceId, root.id, book, syncedAt, index)
      totals.booksCreated += result.booksCreated
      totals.booksUpdated += result.booksUpdated
      totals.highlightsCreated += result.highlightsCreated
      totals.highlightsSkipped += result.highlightsSkipped
    }
  }, {scope: ChangeScope.BlockDefault, description: 'readwise sync'})

  return totals
}

const syncReadwise = async (repo, signal, runtime) => {
  const config = loadConfig()
  if (!config) {
    runtime.status = 'unconfigured'
    return null
  }

  const state = loadState()
  const updatedAfter = normalizeIso(state.updatedAfter) ?? config.initialUpdatedAfter
  runtime.status = 'syncing'
  runtime.lastError = null

  const books = await fetchAllExportedBooks(config, updatedAfter, signal)
  const totals = await upsertBooks(repo, books)
  const latestReadwiseUpdate = maxIso(books.map(bookUpdatedAt))
  const nextUpdatedAfter = latestReadwiseUpdate ?? updatedAfter ?? new Date().toISOString()
  const result = {
    ...totals,
    fetchedBooks: books.length,
    updatedAfter: nextUpdatedAfter,
    lastSyncAt: new Date().toISOString(),
  }

  saveState(result)
  runtime.lastResult = result
  runtime.status = 'running'
  return result
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timeout = window.setTimeout(resolve, ms)
  signal.addEventListener('abort', () => {
    window.clearTimeout(timeout)
    reject(new DOMException('Aborted', 'AbortError'))
  }, {once: true})
})

const pollLoop = async (repo, signal, runtime) => {
  while (!signal.aborted) {
    const config = loadConfig()
    if (!config) {
      runtime.status = 'unconfigured'
      return
    }

    try {
      await syncReadwise(repo, signal, runtime)
    } catch (error) {
      if (signal.aborted) return
      runtime.status = 'error'
      runtime.lastError = error instanceof Error ? error.message : String(error)
      console.error('[readwise-sync]', error)
    }

    const waitMs = clampPollInterval(config.pollIntervalMinutes) * 60_000
    await sleep(waitMs, signal).catch(() => undefined)
  }
}

const createManager = () => ({
  version: VERSION,
  abortController: null,
  status: 'stopped',
  lastError: null,
  lastResult: null,

  start(repo) {
    const config = loadConfig()
    if (!config) {
      this.status = 'unconfigured'
      return false
    }

    this.stop()
    this.abortController = new AbortController()
    this.status = 'running'
    this.lastError = null
    void pollLoop(repo, this.abortController.signal, this)
    return true
  },

  stop() {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.status !== 'unconfigured') this.status = 'stopped'
  },

  async syncOnce(repo) {
    const abortController = new AbortController()
    const wasRunning = Boolean(this.abortController)
    try {
      const result = await syncReadwise(repo, abortController.signal, this)
      this.status = wasRunning ? 'running' : 'stopped'
      return result
    } catch (error) {
      this.status = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      abortController.abort()
    }
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

const yesNo = value => /^y(es)?$/i.test(String(value ?? '').trim())

const configureFromPrompts = repo => {
  const current = loadConfig()
  const tokenPrompt = current?.accessToken
    ? 'Readwise access token (leave blank to keep saved token)'
    : 'Readwise access token'
  const tokenInput = window.prompt(tokenPrompt, '')
  const accessToken = tokenInput || current?.accessToken
  if (!accessToken) return

  const autoStartInput = window.prompt(
    'Auto-sync on app startup? yes/no',
    current?.autoStart ? 'yes' : 'no',
  )
  if (autoStartInput === null) return

  const pollIntervalInput = window.prompt(
    'Sync interval in minutes',
    String(current?.pollIntervalMinutes ?? DEFAULT_POLL_INTERVAL_MINUTES),
  )
  if (pollIntervalInput === null) return

  const initialUpdatedAfterInput = window.prompt(
    'Initial updatedAfter ISO timestamp (blank for full export)',
    current?.initialUpdatedAfter ?? '',
  )
  if (initialUpdatedAfterInput === null) return

  const next = {
    accessToken,
    autoStart: yesNo(autoStartInput),
    pollIntervalMinutes: clampPollInterval(pollIntervalInput),
    initialUpdatedAfter: normalizeIso(initialUpdatedAfterInput),
  }

  saveConfig(next)
  manager().start(repo)
}

const readwiseSyncEffect = {
  id: 'user.readwise.sync',
  start: ({repo}) => {
    const runtime = manager()
    const config = loadConfig()
    if (config?.autoStart) runtime.start(repo)
    return () => runtime.stop()
  },
}

export default [
  ...propertySchemas.map(schema => propertySchemasFacet.of(schema, {source: 'readwise-sync'})),

  appEffectsFacet.of(readwiseSyncEffect, {source: 'readwise-sync'}),

  actionsFacet.of({
    id: 'user.readwise.configure',
    description: 'Configure Readwise sync',
    context: ActionContextTypes.GLOBAL,
    handler: async ({uiStateBlock}) => configureFromPrompts(uiStateBlock.repo),
  }, {source: 'readwise-sync'}),

  actionsFacet.of({
    id: 'user.readwise.sync-now',
    description: 'Sync Readwise now',
    context: ActionContextTypes.GLOBAL,
    handler: async ({uiStateBlock}) => {
      await manager().syncOnce(uiStateBlock.repo)
    },
  }, {source: 'readwise-sync'}),

  actionsFacet.of({
    id: 'user.readwise.start',
    description: 'Start Readwise auto-sync',
    context: ActionContextTypes.GLOBAL,
    handler: async ({uiStateBlock}) => manager().start(uiStateBlock.repo),
  }, {source: 'readwise-sync'}),

  actionsFacet.of({
    id: 'user.readwise.stop',
    description: 'Stop Readwise auto-sync',
    context: ActionContextTypes.GLOBAL,
    handler: async () => manager().stop(),
  }, {source: 'readwise-sync'}),

  actionsFacet.of({
    id: 'user.readwise.reset-cursor',
    description: 'Reset Readwise sync cursor',
    context: ActionContextTypes.GLOBAL,
    handler: async () => removeJson(STATE_KEY),
  }, {source: 'readwise-sync'}),
]
