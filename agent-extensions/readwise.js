import {
  ActionContextTypes,
  ChangeScope,
  actionsFacet,
  codecs,
  defineProperty,
  propertySchemasFacet,
} from '@/extensions/api.js'
import { keyAtEnd, keysBetween } from '@/data/orderKey.js'

const VERSION = 1
const TOKEN_STORAGE_KEY = 'knowledge-medium:readwise:token:v1'
const CHECKPOINT_STORAGE_KEY = 'knowledge-medium:readwise:checkpoint:v1'
const LIBRARY_ALIAS = 'Readwise Library'
const SOURCE = 'readwise-sync'

const userBookIdProp = defineProperty('readwise:user_book_id', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const highlightIdProp = defineProperty('readwise:highlight_id', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const sourceUrlProp = defineProperty('readwise:url', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const categoryProp = defineProperty('readwise:category', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const authorProp = defineProperty('readwise:author', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const titleProp = defineProperty('readwise:title', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const coverProp = defineProperty('readwise:cover_image_url', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const locationProp = defineProperty('readwise:location', {
  codec: codecs.optionalNumber,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const highlightedAtProp = defineProperty('readwise:highlighted_at', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const updatedAtProp = defineProperty('readwise:updated', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})
const noteProp = defineProperty('readwise:note', {
  codec: codecs.optionalString,
  defaultValue: null,
  changeScope: ChangeScope.BlockDefault,
})

const PROPERTY_SCHEMAS = [
  userBookIdProp,
  highlightIdProp,
  sourceUrlProp,
  categoryProp,
  authorProp,
  titleProp,
  coverProp,
  locationProp,
  highlightedAtProp,
  updatedAtProp,
  noteProp,
]

const loadToken = () => {
  const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY)
  return typeof raw === 'string' && raw.length ? raw : null
}

const saveToken = (token) => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

const clearToken = () => {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY)
}

const loadCheckpoint = () => {
  const raw = window.localStorage.getItem(CHECKPOINT_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.updatedAfter === 'string' ? parsed.updatedAfter : null
  } catch {
    return null
  }
}

const saveCheckpoint = (updatedAfter) => {
  window.localStorage.setItem(
    CHECKPOINT_STORAGE_KEY,
    JSON.stringify({ updatedAfter, savedAt: new Date().toISOString() }),
  )
}

const clearCheckpoint = () => {
  window.localStorage.removeItem(CHECKPOINT_STORAGE_KEY)
}

const READWISE_BASE = 'https://readwise.io/api/v2'

const fetchExport = async (token, params) => {
  const url = new URL(`${READWISE_BASE}/export/`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Token ${token}` },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Readwise export ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

const validateToken = async (token) => {
  const response = await fetch(`${READWISE_BASE}/auth/`, {
    method: 'GET',
    headers: { Authorization: `Token ${token}` },
  })
  return response.status === 204
}

const fetchAllPages = async (token, updatedAfter, onProgress) => {
  const books = []
  let pageCursor = null
  let pages = 0
  while (true) {
    pages += 1
    onProgress?.(`Fetching page ${pages}...`)
    const data = await fetchExport(token, { updatedAfter, pageCursor })
    if (Array.isArray(data?.results)) books.push(...data.results)
    if (!data?.nextPageCursor) break
    pageCursor = data.nextPageCursor
  }
  return books
}

const pageTitleForBook = (book) => {
  const title = book.readable_title || book.title || `Readwise ${book.user_book_id}`
  return title.toString().trim() || `Readwise ${book.user_book_id}`
}

const categoryAliasForBook = (book) => {
  const map = {
    books: 'book',
    articles: 'article',
    tweets: 'tweet',
    podcasts: 'podcast',
    supplementals: 'supplemental',
  }
  return map[book.category] || book.category || 'article'
}

const isaContentForBook = (book) =>
  `isa:: [[${categoryAliasForBook(book)}]] [[Readwise]]`

const metadataLinesForBook = (book) => {
  const lines = []
  if (book.author) lines.push(`author:: [[${book.author}]]`)
  if (book.title) lines.push(`Full Title:: ${book.title}`)
  if (book.source_url) lines.push(`source url:: ${book.source_url}`)
  if (book.readwise_url) lines.push(`Readwise URL:: ${book.readwise_url}`)
  if (book.cover_image_url) lines.push(`![cover](${book.cover_image_url})`)
  return lines
}

const formatDateAlias = (date) => {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const day = date.getDate()
  const suffix = (() => {
    if (day >= 11 && day <= 13) return 'th'
    switch (day % 10) {
      case 1: return 'st'
      case 2: return 'nd'
      case 3: return 'rd'
      default: return 'th'
    }
  })()
  return `${months[date.getMonth()]} ${day}${suffix}, ${date.getFullYear()}`
}

const formatTime = (date) => {
  const hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const isPm = hours >= 12
  const display = hours % 12 || 12
  return `${display}:${minutes} ${isPm ? 'PM' : 'AM'}`
}

const syncHeadingContent = (isFirstSync, date) => {
  const datePart = `[[${formatDateAlias(date)}]]`
  return isFirstSync
    ? `### Highlights first synced by [[Readwise]] ${datePart}`
    : `### New highlights added ${datePart} at ${formatTime(date)}`
}

const highlightContent = (highlight) => {
  const text = (highlight.text || '').toString()
  const note = highlight.note ? `\n\n*${highlight.note}*` : ''
  return `${text}${note}`
}

const findOrCreateLibraryRoot = async (tx, workspaceId) => {
  const existing = await tx.findByAlias?.(LIBRARY_ALIAS, workspaceId).catch(() => null)
  if (existing?.id) return existing.id

  const roots = await tx.childrenOf(null, workspaceId)
  for (const candidate of roots) {
    const aliasList = candidate.properties?.alias
    if (Array.isArray(aliasList) && aliasList.includes(LIBRARY_ALIAS)) return candidate.id
    if (aliasList === LIBRARY_ALIAS) return candidate.id
  }

  const id = await tx.create({
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(roots.at(-1)?.orderKey ?? null),
    content: LIBRARY_ALIAS,
    properties: {
      alias: [LIBRARY_ALIAS],
      types: ['page'],
    },
  })
  return id
}

const findBookBlock = async (tx, workspaceId, libraryRootId, userBookId) => {
  const children = await tx.childrenOf(libraryRootId, workspaceId)
  for (const child of children) {
    const id = child.properties?.['readwise:user_book_id']
    if (id === userBookId || (Array.isArray(id) && id.includes(userBookId))) {
      return child
    }
  }
  return null
}

const collectExistingHighlightIds = async (tx, workspaceId, bookBlockId) => {
  const seen = new Set()
  const visit = async (parentId) => {
    const children = await tx.childrenOf(parentId, workspaceId)
    for (const child of children) {
      const id = child.properties?.['readwise:highlight_id']
      if (typeof id === 'string') seen.add(id)
      else if (Array.isArray(id)) id.forEach((value) => seen.add(value))
      await visit(child.id)
    }
  }
  await visit(bookBlockId)
  return seen
}

const upsertBook = async ({ tx, workspaceId, libraryRootId, book, now, log }) => {
  const userBookId = String(book.user_book_id ?? '')
  if (!userBookId) return { created: 0, updated: 0 }

  let bookBlock = await findBookBlock(tx, workspaceId, libraryRootId, userBookId)
  let isFirstSync = false

  if (!bookBlock) {
    isFirstSync = true
    const siblings = await tx.childrenOf(libraryRootId, workspaceId)
    const bookId = await tx.create({
      workspaceId,
      parentId: libraryRootId,
      orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
      content: pageTitleForBook(book),
      properties: {
        'readwise:user_book_id': userBookId,
        'readwise:category': book.category ?? null,
        'readwise:author': book.author ?? null,
        'readwise:title': book.title ?? null,
        'readwise:url': book.source_url ?? null,
        'readwise:cover_image_url': book.cover_image_url ?? null,
        alias: [pageTitleForBook(book)],
        types: ['page'],
      },
    })
    bookBlock = { id: bookId }
    const metadataLines = [isaContentForBook(book), ...metadataLinesForBook(book)]
    const orderKeys = keysBetween(null, null, metadataLines.length)
    for (let i = 0; i < metadataLines.length; i += 1) {
      await tx.create({
        workspaceId,
        parentId: bookId,
        orderKey: orderKeys[i],
        content: metadataLines[i],
      })
    }
  }

  const existingHighlightIds = isFirstSync
    ? new Set()
    : await collectExistingHighlightIds(tx, workspaceId, bookBlock.id)

  const newHighlights = (book.highlights ?? []).filter((highlight) => {
    if (highlight.is_deleted) return false
    const id = String(highlight.id ?? '')
    return id && !existingHighlightIds.has(id)
  })

  if (!newHighlights.length) {
    return { created: 0, updated: isFirstSync ? 0 : 0 }
  }

  const bookChildren = await tx.childrenOf(bookBlock.id, workspaceId)
  const headingId = await tx.create({
    workspaceId,
    parentId: bookBlock.id,
    orderKey: keyAtEnd(bookChildren.at(-1)?.orderKey ?? null),
    content: syncHeadingContent(isFirstSync, now),
  })

  const highlightOrderKeys = keysBetween(null, null, newHighlights.length)
  let count = 0
  for (let i = 0; i < newHighlights.length; i += 1) {
    const highlight = newHighlights[i]
    const id = String(highlight.id ?? '')
    const highlightBlockId = await tx.create({
      workspaceId,
      parentId: headingId,
      orderKey: highlightOrderKeys[i],
      content: highlightContent(highlight),
      properties: {
        'readwise:highlight_id': id,
        'readwise:url': highlight.url ?? highlight.readwise_url ?? null,
        'readwise:location': typeof highlight.location === 'number' ? highlight.location : null,
        'readwise:highlighted_at': highlight.highlighted_at ?? null,
        'readwise:updated': highlight.updated_at ?? null,
        'readwise:note': highlight.note ?? null,
      },
    })
    if (highlight.readwise_url) {
      await tx.create({
        workspaceId,
        parentId: highlightBlockId,
        orderKey: keyAtEnd(null),
        content: `source:: [View Highlight](${highlight.readwise_url})`,
      })
    }
    count += 1
  }

  log(`  ${pageTitleForBook(book)}: +${count} highlight${count === 1 ? '' : 's'}${isFirstSync ? ' (initial)' : ''}`)
  return { created: isFirstSync ? 1 : 0, updated: isFirstSync ? 0 : 1, highlights: count }
}

const runSync = async ({ repo, full, log }) => {
  const token = loadToken()
  if (!token) {
    throw new Error('Readwise token not configured. Run "Configure Readwise" first.')
  }
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('Readwise sync requires an active workspace.')

  const updatedAfter = full ? null : loadCheckpoint()
  log(updatedAfter
    ? `Fetching highlights updated after ${updatedAfter}...`
    : 'Fetching all highlights (initial sync)...')

  const books = await fetchAllPages(token, updatedAfter, log)
  log(`Fetched ${books.length} book/article record${books.length === 1 ? '' : 's'}.`)

  if (!books.length) {
    saveCheckpoint(new Date().toISOString())
    return { books: 0, highlights: 0 }
  }

  const syncStartedAt = new Date()
  let booksTouched = 0
  let highlightsCreated = 0

  await repo.tx(
    async (tx) => {
      const libraryRootId = await findOrCreateLibraryRoot(tx, workspaceId)
      for (const book of books) {
        if (book.is_deleted) continue
        const result = await upsertBook({
          tx,
          workspaceId,
          libraryRootId,
          book,
          now: syncStartedAt,
          log,
        })
        if (result.highlights) booksTouched += 1
        highlightsCreated += result.highlights ?? 0
      }
    },
    { scope: ChangeScope.BlockDefault, description: 'Readwise sync' },
  )

  saveCheckpoint(syncStartedAt.toISOString())
  log(`Done. Touched ${booksTouched} book${booksTouched === 1 ? '' : 's'}, added ${highlightsCreated} highlight${highlightsCreated === 1 ? '' : 's'}.`)
  return { books: booksTouched, highlights: highlightsCreated }
}

const configureFromPrompts = async () => {
  const current = loadToken()
  const message = current
    ? 'Readwise access token (already set — leave blank to keep current)'
    : 'Readwise access token. Get one from https://readwise.io/access_token'
  const entered = window.prompt(message, '')
  if (entered === null) return
  const trimmed = entered.trim()
  if (!trimmed) {
    if (!current) window.alert('No token entered.')
    return
  }
  const ok = await validateToken(trimmed).catch(() => false)
  if (!ok) {
    window.alert('Readwise rejected that token. Not saving.')
    return
  }
  saveToken(trimmed)
  window.alert('Readwise token saved.')
}

const makeLogger = (label) => {
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  return (message) => {
    // eslint-disable-next-line no-console
    console.log(`[${stamp()}] [${label}] ${message}`)
  }
}

export default [
  ...PROPERTY_SCHEMAS.map((prop) => propertySchemasFacet.of(prop, { source: SOURCE })),

  actionsFacet.of({
    id: 'user.readwise.configure',
    description: 'Configure Readwise access token',
    context: ActionContextTypes.GLOBAL,
    handler: async () => configureFromPrompts(),
  }, { source: SOURCE }),

  actionsFacet.of({
    id: 'user.readwise.sync',
    description: 'Sync Readwise highlights (incremental)',
    context: ActionContextTypes.GLOBAL,
    handler: async ({ uiStateBlock }) => {
      const log = makeLogger('readwise')
      try {
        await runSync({ repo: uiStateBlock.repo, full: false, log })
      } catch (error) {
        log(`Error: ${error?.message ?? error}`)
        throw error
      }
    },
  }, { source: SOURCE }),

  actionsFacet.of({
    id: 'user.readwise.sync-full',
    description: 'Sync Readwise highlights (full, ignores checkpoint)',
    context: ActionContextTypes.GLOBAL,
    handler: async ({ uiStateBlock }) => {
      const log = makeLogger('readwise')
      if (!window.confirm('Run a full Readwise sync? This pulls all books and highlights.')) return
      try {
        await runSync({ repo: uiStateBlock.repo, full: true, log })
      } catch (error) {
        log(`Error: ${error?.message ?? error}`)
        throw error
      }
    },
  }, { source: SOURCE }),

  actionsFacet.of({
    id: 'user.readwise.reset-checkpoint',
    description: 'Reset Readwise sync checkpoint',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      clearCheckpoint()
      window.alert('Readwise checkpoint cleared. Next sync will fetch everything.')
    },
  }, { source: SOURCE }),

  actionsFacet.of({
    id: 'user.readwise.disconnect',
    description: 'Disconnect Readwise (clear token and checkpoint)',
    context: ActionContextTypes.GLOBAL,
    handler: async () => {
      if (!window.confirm('Clear stored Readwise token and checkpoint?')) return
      clearToken()
      clearCheckpoint()
      window.alert('Readwise disconnected.')
    },
  }, { source: SOURCE }),
]
// version=${VERSION}
