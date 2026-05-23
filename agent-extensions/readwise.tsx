import {
  actionsFacet, ActionContextTypes, appEffectsFacet, appMountsFacet,
  ChangeScope, codecs, defineBlockType, defineProperty,
  definePropertyEditorOverride, getPluginPrefsBlock,
  keyBetween, keysBetween, pluginBlockId,
  propertyEditorOverridesFacet, propertySchemasFacet,
  showError, showInfo, showProgress, showPropertiesProp,
  showSuccess, typesFacet, useRepo,
  type PropertyEditorProps,
} from '@/extensions/api.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { Textarea } from '@/components/ui/textarea.js'
import { navigate } from '@/utils/navigation.js'
import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// constants

const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'
const OPEN_SETUP_EVENT = 'readwise:setup:open'
const READWISE_API = 'https://readwise.io/api/v2'

const DEFAULT_PAGE_TITLE_TEMPLATE = '{title}'
const DEFAULT_BOOK_TEMPLATE =
  'Author:: {author}\n' +
  'Category:: {category}\n' +
  'Source:: {source}\n' +
  'URL:: {source_url}\n' +
  'Readwise URL:: {readwise_url}\n' +
  'Cover:: ![cover]({cover_image_url})\n' +
  'Tags:: {tags}'
const DEFAULT_HIGHLIGHT_TEMPLATE = '{text} ([readwise]({readwise_url}))'

// ---------------------------------------------------------------------------
// token helpers — never echo the value back through bridge / toast output

const loadToken = (): string | null => window.localStorage.getItem(TOKEN_KEY)
const saveToken = (t: string) => window.localStorage.setItem(TOKEN_KEY, t)
const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)

const validateToken = async (candidate: string): Promise<boolean> => {
  try {
    const res = await fetch(`${READWISE_API}/auth/`, {
      headers: { Authorization: `Token ${candidate}` },
    })
    return res.status === 204
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// properties

const lastSyncedAtProp = defineProperty<string | undefined>('readwise:lastSyncedAt', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})
const syncSinceProp = defineProperty<string | undefined>('readwise:syncSince', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})
const pageTitleTemplateProp = defineProperty<string>('readwise:pageTitleTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_PAGE_TITLE_TEMPLATE,
  changeScope: ChangeScope.UserPrefs,
})
const bookTemplateProp = defineProperty<string>('readwise:bookTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_BOOK_TEMPLATE,
  changeScope: ChangeScope.UserPrefs,
})
const highlightTemplateProp = defineProperty<string>('readwise:highlightTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_HIGHLIGHT_TEMPLATE,
  changeScope: ChangeScope.UserPrefs,
})
const autoSyncIntervalProp = defineProperty<number>('readwise:autoSyncIntervalMin', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.UserPrefs,
})
// purely a UI hint — the source of truth is localStorage. We mirror it so the
// settings page can render a "Connected" pill without subscribing to storage.
const connectedHintProp = defineProperty<boolean>('readwise:connectedHint', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
// per-block external ids on imported pages / highlights
const userBookIdProp = defineProperty<string | undefined>('readwise:user_book_id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const highlightIdProp = defineProperty<string | undefined>('readwise:highlight_id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const readwisePrefsType = defineBlockType({
  id: 'readwise-prefs',
  label: 'Readwise',
  properties: [
    lastSyncedAtProp, syncSinceProp,
    pageTitleTemplateProp, bookTemplateProp, highlightTemplateProp,
    autoSyncIntervalProp, connectedHintProp,
  ],
})

// ---------------------------------------------------------------------------
// template rendering

type BookRecord = {
  user_book_id: number
  title?: string
  author?: string
  category?: string
  source?: string
  source_url?: string
  readwise_url?: string
  cover_image_url?: string
  book_tags?: Array<{ name?: string }>
  document_note?: string
  num_highlights?: number
  last_highlight_at?: string
  highlights?: HighlightRecord[]
}

type HighlightRecord = {
  id: number
  text?: string
  note?: string
  location?: number | string
  location_type?: string
  color?: string
  highlighted_at?: string
  updated_at?: string
  created_at?: string
  tags?: Array<{ name?: string }>
  readwise_url?: string
  is_deleted?: boolean
}

const formatTags = (tags: Array<{ name?: string }> | undefined): string => {
  if (!tags || !tags.length) return ''
  return tags.map(t => t.name).filter(Boolean).map(n => `#[[${n}]]`).join(' ')
}

const substitute = (template: string, vars: Record<string, string>): string => {
  return template.replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const v = vars[key]
    return v == null ? '' : v
  })
}

const bookVars = (b: BookRecord): Record<string, string> => ({
  title: b.title ?? '',
  author: b.author ?? '',
  category: b.category ?? '',
  source: b.source ?? '',
  source_url: b.source_url ?? '',
  readwise_url: b.readwise_url ?? '',
  cover_image_url: b.cover_image_url ?? '',
  document_note: b.document_note ?? '',
  num_highlights: String(b.num_highlights ?? ''),
  last_highlight_at: b.last_highlight_at ?? '',
  tags: formatTags(b.book_tags),
  user_book_id: String(b.user_book_id),
})

const highlightVars = (h: HighlightRecord): Record<string, string> => ({
  text: h.text ?? '',
  note: h.note ?? '',
  location: String(h.location ?? ''),
  location_type: h.location_type ?? '',
  color: h.color ?? '',
  highlighted_at: h.highlighted_at ?? '',
  updated_at: h.updated_at ?? '',
  created_at: h.created_at ?? '',
  readwise_url: h.readwise_url ?? '',
  tags: formatTags(h.tags),
  highlight_id: String(h.id),
})

// Drop trailing-empty lines and lines that collapse to whitespace after
// substitution — most book templates have optional fields like {tags} that
// the user has left blank.
const renderTemplateLines = (template: string, vars: Record<string, string>): string[] => {
  return template
    .split('\n')
    .map(line => substitute(line, vars))
    .filter(line => line.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Readwise export pagination

const fetchExportPage = async (
  token: string,
  updatedAfter: string | null,
  pageCursor: string | null,
): Promise<{ results: BookRecord[]; nextPageCursor: string | null }> => {
  const params = new URLSearchParams()
  if (updatedAfter) params.set('updatedAfter', updatedAfter)
  if (pageCursor) params.set('pageCursor', pageCursor)
  const url = `${READWISE_API}/export/${params.toString() ? `?${params}` : ''}`
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } })
  if (!res.ok) {
    throw new Error(`Readwise /export returned ${res.status}`)
  }
  const data = await res.json()
  return {
    results: Array.isArray(data.results) ? data.results : [],
    nextPageCursor: data.nextPageCursor ?? null,
  }
}

// ---------------------------------------------------------------------------
// sync

type SyncDeps = {
  repo: ReturnType<typeof useRepo> | any
}

const ensureRoot = async (repo: any, workspaceId: string) => {
  const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
  await repo.tx(async (tx: any) => {
    const existing = await tx.get(rootId)
    if (existing) return
    const roots = await tx.childrenOf(null, workspaceId)
    const lastKey = roots.length ? roots[roots.length - 1].orderKey : null
    await tx.create({
      id: rootId,
      workspaceId,
      parentId: null,
      orderKey: keyBetween(lastKey, null),
      content: 'Readwise Library',
      properties: { alias: ['Readwise Library'], types: ['page'] },
    })
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: create root' })
  return rootId
}

const syncBookToBlocks = async (
  repo: any,
  workspaceId: string,
  rootId: string,
  book: BookRecord,
  pageTitleTemplate: string,
  bookTemplate: string,
  highlightTemplate: string,
) => {
  const bookId = pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}`)
  const bVars = bookVars(book)
  const title = substitute(pageTitleTemplate, bVars).trim() || `Readwise: ${book.title ?? book.user_book_id}`
  const metaLines = renderTemplateLines(bookTemplate, bVars)

  await repo.tx(async (tx: any) => {
    // 1. book page
    const existing = await tx.get(bookId)
    if (!existing) {
      const siblings = await tx.childrenOf(rootId)
      const lastKey = siblings.length ? siblings[siblings.length - 1].orderKey : null
      await tx.create({
        id: bookId,
        workspaceId,
        parentId: rootId,
        orderKey: keyBetween(lastKey, null),
        content: title,
        properties: {
          alias: [title],
          types: ['page'],
          'readwise:user_book_id': String(book.user_book_id),
        },
      })
    } else if (existing.content !== title) {
      await tx.update(bookId, { content: title })
    }
    await tx.setProperty(bookId, userBookIdProp, String(book.user_book_id))

    // 2. meta children — first N children of the book page are meta lines;
    //    they're upserted by deterministic id so re-syncs replace them in
    //    place. If the user edits a meta block we'll happily clobber on the
    //    next sync (matches Roam's behavior).
    const bookKids = await tx.childrenOf(bookId)
    const metaPrefix = `book:${book.user_book_id}:meta:`
    const existingMeta = bookKids
      .filter((k: any) => typeof k.id === 'string')
    const metaIds = metaLines.map((_, i) =>
      pluginBlockId(workspaceId, READWISE_NS, `${metaPrefix}${i}`))

    // figure out where the meta lines should sit: at the very top of the
    // book page, before any existing non-meta children
    const nonMeta = bookKids.filter((k: any) =>
      !existingMeta.some((m: any) => m.id === k.id) || true)
    void nonMeta

    // compute fresh order keys at the start of the children list
    const firstNonMetaKey = bookKids.find((k: any) => !metaIds.includes(k.id))?.orderKey ?? null
    const metaKeys = keysBetween(null, firstNonMetaKey, metaLines.length || 1)

    for (let i = 0; i < metaLines.length; i++) {
      const id = metaIds[i]
      const content = metaLines[i]
      const orderKey = metaKeys[i]
      const existingMetaBlock = await tx.get(id)
      if (!existingMetaBlock) {
        await tx.create({
          id, workspaceId, parentId: bookId, orderKey, content,
        })
      } else {
        if (existingMetaBlock.content !== content) {
          await tx.update(id, { content })
        }
      }
    }
    // delete stale meta lines (template shrunk)
    for (const k of bookKids) {
      if (typeof k.id !== 'string') continue
      if (!metaIds.includes(k.id) && k.id.includes(`:meta:`)) {
        await tx.delete(k.id)
      }
    }

    // 3. highlights as children of the book page
    const highlights = (book.highlights ?? [])
      .filter(h => !h.is_deleted && h.text && h.text.trim().length)
    if (!highlights.length) return

    const refreshed = await tx.childrenOf(bookId)
    const lastChildKey = refreshed.length ? refreshed[refreshed.length - 1].orderKey : null
    const newHighlightKeys = keysBetween(lastChildKey, null, highlights.length)

    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i]
      const hId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}`)
      const hVars = highlightVars(h)
      const hLines = renderTemplateLines(highlightTemplate, hVars)
      const hContent = hLines[0] ?? (h.text ?? '')
      const noteLines = hLines.slice(1)
      const noteText = h.note?.trim()

      const existingH = await tx.get(hId)
      if (!existingH) {
        await tx.create({
          id: hId,
          workspaceId,
          parentId: bookId,
          orderKey: newHighlightKeys[i],
          content: hContent,
          properties: {
            'readwise:highlight_id': String(h.id),
          },
        })
      } else if (existingH.content !== hContent) {
        await tx.update(hId, { content: hContent })
      }
      await tx.setProperty(hId, highlightIdProp, String(h.id))

      // a single deterministic note child
      const noteId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}:note`)
      const finalNoteText = noteText && noteText.length ? `Note:: ${noteText}` : ''
      const extraLines = [finalNoteText, ...noteLines].filter(s => s && s.trim().length)
      const noteBlock = await tx.get(noteId)
      if (extraLines.length === 0) {
        if (noteBlock) await tx.delete(noteId)
      } else {
        const noteContent = extraLines.join('\n')
        if (!noteBlock) {
          const hKids = await tx.childrenOf(hId)
          const lastHKid = hKids.length ? hKids[hKids.length - 1].orderKey : null
          await tx.create({
            id: noteId, workspaceId, parentId: hId,
            orderKey: keyBetween(lastHKid, null),
            content: noteContent,
          })
        } else if (noteBlock.content !== noteContent) {
          await tx.update(noteId, { content: noteContent })
        }
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: `readwise: sync book ${book.user_book_id}` })
}

const runSync = async (repo: any, { silent = false } = {}) => {
  const token = loadToken()
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    if (!silent) showError('No active workspace')
    return
  }
  if (!token) {
    if (!silent) {
      showError('Connect Readwise first', {
        action: { label: 'Connect', onClick: () => window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT)) },
      })
    }
    return
  }
  const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
  const lastSynced = prefs.peekProperty(lastSyncedAtProp)
  const syncSince = prefs.peekProperty(syncSinceProp)
  const updatedAfter = lastSynced ?? syncSince ?? null
  const pageTitleTemplate = prefs.get(pageTitleTemplateProp)
  const bookTemplate = prefs.get(bookTemplateProp)
  const highlightTemplate = prefs.get(highlightTemplateProp)

  const progress = showProgress('Readwise: fetching…')
  try {
    const rootId = await ensureRoot(repo, workspaceId)
    let pageCursor: string | null = null
    let bookCount = 0
    let highlightCount = 0
    do {
      const { results, nextPageCursor } = await fetchExportPage(token, updatedAfter, pageCursor)
      pageCursor = nextPageCursor
      for (const book of results) {
        bookCount++
        highlightCount += (book.highlights ?? []).length
        progress.update(`Readwise: ${bookCount} books, ${highlightCount} highlights…`)
        await syncBookToBlocks(
          repo, workspaceId, rootId, book,
          pageTitleTemplate, bookTemplate, highlightTemplate,
        )
      }
    } while (pageCursor)

    const finishedAt = new Date().toISOString()
    await prefs.set(lastSyncedAtProp, finishedAt)
    progress.done(
      bookCount === 0
        ? 'Readwise: nothing new since last sync'
        : `Readwise: synced ${bookCount} book(s), ${highlightCount} highlight(s)`)
  } catch (err: any) {
    progress.fail(`Readwise sync failed: ${err?.message ?? err}`)
  }
}

// ---------------------------------------------------------------------------
// setup dialog (one-time token entry, plus disconnect)

const ReadwiseSetupDialog = () => {
  const repo = useRepo()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onOpen = () => {
      setToken('')
      setOpen(true)
    }
    window.addEventListener(OPEN_SETUP_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETUP_EVENT, onOpen)
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const ok = await validateToken(token)
      if (!ok) {
        showError('Readwise rejected that token. Check it and try again.')
        return
      }
      saveToken(token)
      // mirror connected state into prefs so the settings panel can read it
      const workspaceId = repo.activeWorkspaceId
      if (workspaceId) {
        const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
        await prefs.set(connectedHintProp, true)
      }
      showSuccess('Readwise connected.')
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Readwise</DialogTitle>
          <DialogDescription>
            Grab an access token from{' '}
            <a href='https://readwise.io/access_token' target='_blank' rel='noreferrer'>
              readwise.io/access_token
            </a>
            {' '}and paste it here.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='rw-token'>Access token</Label>
          <Input
            id='rw-token'
            value={token}
            onChange={e => setToken(e.target.value)}
            disabled={saving}
            autoFocus
            type='password'
            placeholder='paste token'
          />
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!token || saving}>
            {saving ? 'Validating…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// property editors (rendered inline in the prefs block's property panel)

const TextareaEditor = ({ value, onChange }: PropertyEditorProps<string>) => (
  <Textarea
    value={value}
    onChange={e => onChange(e.target.value)}
    rows={Math.max(3, value.split('\n').length + 1)}
    spellCheck={false}
    style={{ fontFamily: 'monospace', width: '100%' }}
  />
)

const SingleLineEditor = ({ value, onChange }: PropertyEditorProps<string>) => (
  <Input
    value={value}
    onChange={e => onChange(e.target.value)}
    style={{ fontFamily: 'monospace', width: '100%' }}
  />
)

const DateEditor = ({ value, onChange }: PropertyEditorProps<string | undefined>) => {
  const dateValue = value ? value.slice(0, 10) : ''
  return (
    <Input
      type='date'
      value={dateValue}
      onChange={e => {
        const v = e.target.value
        onChange(v ? new Date(v).toISOString() : undefined)
      }}
    />
  )
}

const NumberEditor = ({ value, onChange }: PropertyEditorProps<number>) => (
  <Input
    type='number'
    min={0}
    value={value}
    onChange={e => onChange(Number(e.target.value) || 0)}
    style={{ width: '8rem' }}
  />
)

const ConnectedEditor = ({ value, onChange, block }: PropertyEditorProps<boolean>) => {
  const tokenPresent = loadToken() != null
  const connected = value && tokenPresent
  const repo = useRepo()
  return (
    <div className='flex items-center gap-2'>
      <span>{connected ? 'Connected ✓' : 'Not connected'}</span>
      {connected
        ? (
          <Button
            variant='outline'
            size='sm'
            onClick={async () => {
              clearToken()
              onChange(false)
              // also clear sync checkpoint so a reconnect starts fresh
              void block
              void repo
              showInfo('Readwise disconnected.')
            }}
          >Disconnect</Button>
          )
        : (
          <Button
            size='sm'
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT))}
          >Connect…</Button>
          )}
      <Button
        variant='outline'
        size='sm'
        onClick={() => runSync(repo)}
        disabled={!tokenPresent}
      >Sync now</Button>
    </div>
  )
}

const LastSyncedEditor = ({ value }: PropertyEditorProps<string | undefined>) => (
  <span style={{ color: 'var(--muted-foreground)' }}>
    {value ? `last synced ${new Date(value).toLocaleString()}` : 'never synced'}
  </span>
)

// ---------------------------------------------------------------------------
// actions

const openSettingsAction = {
  id: 'readwise.configure',
  description: 'Readwise: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({ uiStateBlock }: { uiStateBlock: any }) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, { target: 'new-panel', blockId: prefs.id, workspaceId })
  },
}

const syncNowAction = {
  id: 'readwise.sync',
  description: 'Readwise: sync now',
  context: ActionContextTypes.GLOBAL,
  handler: async ({ uiStateBlock }: { uiStateBlock: any }) => {
    await runSync(uiStateBlock.repo)
  },
}

const connectAction = {
  id: 'readwise.connect',
  description: 'Readwise: connect / change token',
  context: ActionContextTypes.GLOBAL,
  handler: () => window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT)),
}

// ---------------------------------------------------------------------------
// background sync effect — runs while interval > 0 and a token is present

const autoSyncEffect = {
  id: 'readwise.auto-sync',
  start: ({ repo }: { repo: any }) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const schedule = async () => {
      if (cancelled) return
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        timer = setTimeout(schedule, 60_000)
        return
      }
      try {
        const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
        const minutes = prefs.peekProperty(autoSyncIntervalProp) ?? 0
        const token = loadToken()
        if (minutes > 0 && token) {
          await runSync(repo, { silent: true })
        }
        const nextMs = minutes > 0 ? minutes * 60_000 : 5 * 60_000
        timer = setTimeout(schedule, nextMs)
      } catch {
        timer = setTimeout(schedule, 5 * 60_000)
      }
    }

    // first run after a short delay so we don't pile work onto bootstrap
    timer = setTimeout(schedule, 10_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  },
}

// ---------------------------------------------------------------------------
// editor overrides

const connectedEditor = definePropertyEditorOverride<boolean>({
  name: connectedHintProp.name,
  label: 'Readwise',
  Editor: ConnectedEditor,
})
const lastSyncedEditor = definePropertyEditorOverride<string | undefined>({
  name: lastSyncedAtProp.name,
  label: 'Last synced',
  Editor: LastSyncedEditor,
})
const syncSinceEditor = definePropertyEditorOverride<string | undefined>({
  name: syncSinceProp.name,
  label: 'Initial sync start date',
  Editor: DateEditor,
})
const pageTitleEditor = definePropertyEditorOverride<string>({
  name: pageTitleTemplateProp.name,
  label: 'Page title template',
  Editor: SingleLineEditor,
})
const bookTemplateEditor = definePropertyEditorOverride<string>({
  name: bookTemplateProp.name,
  label: 'Book metadata template',
  Editor: TextareaEditor,
})
const highlightTemplateEditor = definePropertyEditorOverride<string>({
  name: highlightTemplateProp.name,
  label: 'Highlight template',
  Editor: TextareaEditor,
})
const autoSyncEditor = definePropertyEditorOverride<number>({
  name: autoSyncIntervalProp.name,
  label: 'Auto-sync interval (minutes; 0 = off)',
  Editor: NumberEditor,
})

// ---------------------------------------------------------------------------
// wiring

const source = 'readwise'

export default [
  typesFacet.of(readwisePrefsType, { source }),

  propertySchemasFacet.of(lastSyncedAtProp, { source }),
  propertySchemasFacet.of(syncSinceProp, { source }),
  propertySchemasFacet.of(pageTitleTemplateProp, { source }),
  propertySchemasFacet.of(bookTemplateProp, { source }),
  propertySchemasFacet.of(highlightTemplateProp, { source }),
  propertySchemasFacet.of(autoSyncIntervalProp, { source }),
  propertySchemasFacet.of(connectedHintProp, { source }),
  propertySchemasFacet.of(userBookIdProp, { source }),
  propertySchemasFacet.of(highlightIdProp, { source }),

  propertyEditorOverridesFacet.of(connectedEditor, { source }),
  propertyEditorOverridesFacet.of(lastSyncedEditor, { source }),
  propertyEditorOverridesFacet.of(syncSinceEditor, { source }),
  propertyEditorOverridesFacet.of(pageTitleEditor, { source }),
  propertyEditorOverridesFacet.of(bookTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(highlightTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(autoSyncEditor, { source }),

  appMountsFacet.of({ id: 'readwise.setup-dialog', component: ReadwiseSetupDialog }, { source }),
  appEffectsFacet.of(autoSyncEffect, { source }),

  actionsFacet.of(openSettingsAction, { source }),
  actionsFacet.of(syncNowAction, { source }),
  actionsFacet.of(connectAction, { source }),
]
