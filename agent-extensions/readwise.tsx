import {
  actionsFacet, appEffectsFacet, appMountsFacet, blockRenderersFacet,
} from '@/extensions/core.js'
import {
  actionDispatchWrap, type ActionDispatchDecorator,
} from '@/shortcuts/actionDispatch.js'
import {
  blockContentDecoratorsFacet,
  cachedContentDecorator,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import {
  ChangeScope, seedType, definePropertyEditorOverride, seedProperty,
  type PropertyEditorProps,
  type PropertySchema,
  type PropertySeedDeclaration,
  type TypedBlockQuery,
} from '@/data/api/index.js'
import { definitionSeedsFacet, propertyEditorOverridesFacet, typeSeedsFacet } from '@/data/facets.js'
import { safeDecodeRowProperty } from '@/data/rowProperty.js'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import { keyBetween, keysBetween } from '@/data/orderKey.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { showError, showInfo, showProgress, showSuccess } from '@/utils/toast.js'
import { truncate } from '@/utils/string.js'
import { openDialog, type DialogContextProps } from '@/utils/dialogs.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { mergeAliasCollision } from '@/plugins/alias/mergeCollisionAction.js'
import { useRepo } from '@/context/repo.js'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { getOrCreateKernelPage } from '@/data/kernelPage.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { LazyBlockEntry } from '@/plugins/backlinks/BlockEntry.js'
import { dueByDailyNoteRef } from '@/plugins/daily-notes/dueQuery.js'
import { useStartOfToday } from '@/plugins/daily-notes/today.js'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes.js'
import { aliasesProp, getBlockTypes, showPropertiesProp } from '@/data/properties.js'
import { createOrRestoreTargetBlock, ensureAliasTarget, partitionClaimableAliases } from '@/data/targets.js'
import {
  addDaysIso, dailyNoteBlockId, getOrCreateDailyNote, todayIso,
} from '@/plugins/daily-notes/dailyNotes.js'
import { leftSidebarSectionsFacet } from '@/plugins/left-sidebar/facet.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import {
  EDIT_MODE_TODO_CYCLE_ACTION_ID,
  TODO_CYCLE_ACTION_ID,
} from '@/plugins/todo/actions.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextType,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { Textarea } from '@/components/ui/textarea.js'
import {
  navigate, navigateFromGlobalCommand, useBlockOpener, useOpenBlock,
} from '@/utils/navigation.js'
import { buildAppHash } from '@/utils/routing.js'
import { useBlockQuery, useHandle, useManyParents } from '@/hooks/block.js'
import type { BlockData, BlockRenderer, BlockRendererProps } from '@/types.js'
import {
  useCallback, useEffect, useMemo, useState, useSyncExternalStore,
  type ComponentType, type CSSProperties,
} from 'react'

// ---------------------------------------------------------------------------
// constants

const READWISE_NS = '45fb169f-ffac-458b-b2a7-6cec87d2d7ee'
const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'

// Setup-dialog visibility — a typed module store, NOT a window CustomEvent.
// The connect action / header button / "Connect" toast flip it directly;
// the mounted dialog reads it with useSyncExternalStore (the same mechanism
// the app's own DialogHost uses).
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
const READWISE_API = 'https://readwise.io/api/v2'
const READWISE_LIBRARY_TYPE = 'readwise-library'
const READWISE_DOCUMENT_TYPE = 'readwise-document'
const READWISE_HIGHLIGHT_TYPE = 'readwise-highlight'
const READWISE_NOTE_TYPE = 'readwise-note'
const HIGHLIGHTS_SECTION_CONTENT = 'Highlights'
const REVIEW_ROLLOVER_BUFFER_MINUTES = 120

const DEFAULT_PAGE_TITLE_TEMPLATE = '{title}'
const DEFAULT_BOOK_TEMPLATE = ''
const DEFAULT_HIGHLIGHT_TEMPLATE = '{text}'

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

const lastSyncedAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('last-synced-at'),
  revision: 1,
  name: 'readwise:lastSyncedAt',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})
const syncSinceProp = seedProperty({
  seedKey: extensionPropertySeedKey('sync-since'),
  revision: 1,
  name: 'readwise:syncSince',
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const pageTitleTemplateProp = seedProperty({
  seedKey: extensionPropertySeedKey('page-title-template'),
  revision: 1,
  name: 'readwise:pageTitleTemplate',
  preset: 'string',
  defaultValue: DEFAULT_PAGE_TITLE_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const bookTemplateProp = seedProperty({
  seedKey: extensionPropertySeedKey('book-template'),
  revision: 1,
  name: 'readwise:bookTemplate',
  preset: 'string',
  defaultValue: DEFAULT_BOOK_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const highlightTemplateProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-template'),
  revision: 1,
  name: 'readwise:highlightTemplate',
  preset: 'string',
  defaultValue: DEFAULT_HIGHLIGHT_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const autoSyncIntervalProp = seedProperty({
  seedKey: extensionPropertySeedKey('auto-sync-interval-min'),
  revision: 1,
  name: 'readwise:autoSyncIntervalMin',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})
const authorPageTypesProp = seedProperty({
  seedKey: extensionPropertySeedKey('author-page-types'),
  revision: 1,
  name: 'readwise:authorPageTypes',
  preset: 'refList',
  config: { targetTypes: [BLOCK_TYPE_TYPE] },
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const documentPageTypesProp = seedProperty({
  seedKey: extensionPropertySeedKey('document-page-types'),
  revision: 1,
  name: 'readwise:documentPageTypes',
  preset: 'refList',
  config: { targetTypes: [BLOCK_TYPE_TYPE] },
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const highlightTypesProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-types'),
  revision: 1,
  name: 'readwise:highlightTypes',
  preset: 'refList',
  config: { targetTypes: [BLOCK_TYPE_TYPE] },
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
// purely a UI hint — the source of truth is localStorage. We mirror it so the
// settings page can render a "Connected" pill without subscribing to storage.
const connectedHintProp = seedProperty({
  seedKey: extensionPropertySeedKey('connected-hint'),
  revision: 1,
  name: 'readwise:connectedHint',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
// per-block external ids on imported pages / highlights
const userBookIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('user-book-id'),
  revision: 1,
  name: 'readwise:user_book_id',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const highlightIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-id'),
  revision: 1,
  name: 'readwise:highlight_id',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const titleProp = seedProperty({
  seedKey: extensionPropertySeedKey('title'),
  revision: 1,
  name: 'readwise:title',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const authorProp = seedProperty({
  seedKey: extensionPropertySeedKey('author'),
  revision: 1,
  name: 'readwise:author',
  preset: 'ref',
  config: { targetTypes: [PAGE_TYPE] },
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const categoryProp = seedProperty({
  seedKey: extensionPropertySeedKey('category'),
  revision: 1,
  name: 'readwise:category',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const sourceProp = seedProperty({
  seedKey: extensionPropertySeedKey('source'),
  revision: 1,
  name: 'readwise:source',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const sourceUrlProp = seedProperty({
  seedKey: extensionPropertySeedKey('source-url'),
  revision: 1,
  name: 'readwise:source_url',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseUrlProp = seedProperty({
  seedKey: extensionPropertySeedKey('readwise-url'),
  revision: 1,
  name: 'readwise:readwise_url',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const coverImageUrlProp = seedProperty({
  seedKey: extensionPropertySeedKey('cover-image-url'),
  revision: 1,
  name: 'readwise:cover_image_url',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const documentNoteProp = seedProperty({
  seedKey: extensionPropertySeedKey('document-note'),
  revision: 1,
  name: 'readwise:document_note',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const numHighlightsProp = seedProperty({
  seedKey: extensionPropertySeedKey('num-highlights'),
  revision: 1,
  name: 'readwise:num_highlights',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const lastHighlightAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('last-highlight-at'),
  revision: 1,
  name: 'readwise:last_highlight_at',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const asinProp = seedProperty({
  seedKey: extensionPropertySeedKey('asin'),
  revision: 1,
  name: 'readwise:asin',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
// The shared string-list preset core exposes readonly values; cast back to
// this property's historical string[] handle contract (same idiom as
// `aliasesProp` in `@/data/properties`) so downstream consumers that build
// and assign plain string[] arrays don't all need a readonly-array update.
const tagsProp = seedProperty({
  seedKey: extensionPropertySeedKey('tags'),
  revision: 1,
  name: 'readwise:tags',
  preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
}) as PropertySeedDeclaration<string[]>
const locationProp = seedProperty({
  seedKey: extensionPropertySeedKey('location'),
  revision: 1,
  name: 'readwise:location',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const locationTypeProp = seedProperty({
  seedKey: extensionPropertySeedKey('location-type'),
  revision: 1,
  name: 'readwise:location_type',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const colorProp = seedProperty({
  seedKey: extensionPropertySeedKey('color'),
  revision: 1,
  name: 'readwise:color',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const highlightedAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlighted-at'),
  revision: 1,
  name: 'readwise:highlighted_at',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const updatedAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('updated-at'),
  revision: 1,
  name: 'readwise:updated_at',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const createdAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('created-at'),
  revision: 1,
  name: 'readwise:created_at',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const noteForHighlightIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('note-for-highlight-id'),
  revision: 1,
  name: 'readwise:note_for_highlight_id',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const reviewDateProp = seedProperty({
  seedKey: extensionPropertySeedKey('review-date'),
  revision: 1,
  name: 'readwise:review_date',
  preset: 'ref',
  config: { targetTypes: [DAILY_NOTE_TYPE] },
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const reviewedProp = seedProperty({
  seedKey: extensionPropertySeedKey('reviewed'),
  revision: 1,
  name: 'readwise:reviewed',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const readwisePrefsType = seedType({
  seedKey: extensionTypeSeedKey('prefs'),
  revision: 1,
  id: 'readwise-prefs',
  label: 'Readwise',
  // Prefs container is plumbing for the # dropdown (typing #Readwise
  // must offer creating the user's own type, not tag with this);
  // the chip stays informative on the container block itself.
  hideFromCompletion: true,
  properties: [
    lastSyncedAtProp, syncSinceProp,
    pageTitleTemplateProp, bookTemplateProp, highlightTemplateProp,
    autoSyncIntervalProp, authorPageTypesProp, documentPageTypesProp,
    highlightTypesProp, connectedHintProp,
  ],
})
const readwiseLibraryType = seedType({
  seedKey: extensionTypeSeedKey('library'),
  revision: 1,
  id: READWISE_LIBRARY_TYPE,
  label: 'Readwise library',
  // Singleton root marker, same rationale as the prefs container.
  hideFromCompletion: true,
})
const readwiseDocumentType = seedType({
  seedKey: extensionTypeSeedKey('document'),
  revision: 1,
  id: READWISE_DOCUMENT_TYPE,
  label: 'Readwise document',
  description: 'A document imported from Readwise Reader or the Readwise export API.',
  properties: [
    userBookIdProp, titleProp, authorProp, categoryProp, sourceProp,
    sourceUrlProp, readwiseUrlProp, coverImageUrlProp, documentNoteProp,
    numHighlightsProp, lastHighlightAtProp, asinProp, tagsProp,
  ],
})
const readwiseHighlightType = seedType({
  seedKey: extensionTypeSeedKey('highlight'),
  revision: 1,
  id: READWISE_HIGHLIGHT_TYPE,
  label: 'Readwise highlight',
  description: 'A highlight imported from Readwise.',
  properties: [
    highlightIdProp, userBookIdProp, readwiseUrlProp, locationProp, locationTypeProp,
    colorProp, highlightedAtProp, updatedAtProp, createdAtProp, tagsProp,
    reviewDateProp, reviewedProp,
  ],
})
const readwiseNoteType = seedType({
  seedKey: extensionTypeSeedKey('note'),
  revision: 1,
  id: READWISE_NOTE_TYPE,
  label: 'Readwise note',
  properties: [noteForHighlightIdProp],
})

const DOCUMENT_PROPERTY_SCHEMAS = [
  userBookIdProp,
  titleProp,
  authorProp,
  categoryProp,
  sourceProp,
  sourceUrlProp,
  readwiseUrlProp,
  coverImageUrlProp,
  documentNoteProp,
  numHighlightsProp,
  lastHighlightAtProp,
  asinProp,
  tagsProp,
]
const HIGHLIGHT_PROPERTY_SCHEMAS = [
  userBookIdProp,
  highlightIdProp,
  readwiseUrlProp,
  tagsProp,
  locationProp,
  locationTypeProp,
  colorProp,
  highlightedAtProp,
  updatedAtProp,
  createdAtProp,
]
const NOTE_PROPERTY_SCHEMAS = [
  noteForHighlightIdProp,
]
const HIGHLIGHT_REVIEW_PROPERTY_SCHEMAS = [
  reviewDateProp,
  reviewedProp,
]
const IMPORTED_PROPERTY_SCHEMAS = [
  ...DOCUMENT_PROPERTY_SCHEMAS,
  ...HIGHLIGHT_PROPERTY_SCHEMAS.filter(schema =>
    !DOCUMENT_PROPERTY_SCHEMAS.some(existing => existing.name === schema.name)),
  ...NOTE_PROPERTY_SCHEMAS,
  ...HIGHLIGHT_REVIEW_PROPERTY_SCHEMAS,
]

// ---------------------------------------------------------------------------
// document decorator

type ReadwiseDocumentMeta = {
  title?: string
  authorId?: string
  category?: string
  source?: string
  sourceUrl?: string
  readwiseUrl?: string
  coverImageUrl?: string
  documentNote?: string
  numHighlights?: number
  lastHighlightAt?: string
  asin?: string
  tags: string[]
}

const readBlockProperty = <T,>(block: Block, schema: PropertySchema<T>): T | undefined => {
  try {
    return block.peekProperty(schema)
  } catch {
    return undefined
  }
}

const readwiseDocumentMeta = (block: Block): ReadwiseDocumentMeta => ({
  title: readBlockProperty(block, titleProp),
  authorId: readBlockProperty(block, authorProp),
  category: readBlockProperty(block, categoryProp),
  source: readBlockProperty(block, sourceProp),
  sourceUrl: readBlockProperty(block, sourceUrlProp),
  readwiseUrl: readBlockProperty(block, readwiseUrlProp),
  coverImageUrl: readBlockProperty(block, coverImageUrlProp),
  documentNote: readBlockProperty(block, documentNoteProp),
  numHighlights: readBlockProperty(block, numHighlightsProp),
  lastHighlightAt: readBlockProperty(block, lastHighlightAtProp),
  asin: readBlockProperty(block, asinProp),
  tags: readBlockProperty(block, tagsProp) ?? [],
})

const cleanText = (value: string | undefined): string | undefined => {
  const text = value?.trim()
  return text ? text : undefined
}

const formatReadwiseDate = (value: string | undefined): string | undefined => {
  const text = cleanText(value)
  if (!text) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

const hostLabel = (value: string | undefined): string | undefined => {
  const text = cleanText(value)
  if (!text) return undefined
  try {
    return new URL(text).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const highlightCountLabel = (count: number | undefined): string | undefined => {
  if (count === undefined || !Number.isFinite(count)) return undefined
  const unit = count === 1 ? 'highlight' : 'highlights'
  return `${count.toLocaleString()} ${unit}`
}

const titleInitial = (meta: ReadwiseDocumentMeta, fallback: string | undefined): string => {
  const source = cleanText(meta.title) ?? cleanText(fallback) ?? 'R'
  return source.slice(0, 1).toUpperCase()
}

const decodeAliasLabel = (data: BlockData | undefined): string | undefined => {
  if (!data) return undefined
  try {
    const aliases = aliasesProp.codec.decode(data.properties[aliasesProp.name])
    return cleanText(aliases[0]) ?? cleanText(data.content)
  } catch {
    return cleanText(data.content)
  }
}

const readwiseDocumentStyles = {
  card: {
    display: 'flex',
    width: '100%',
    alignItems: 'stretch',
    gap: 16,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--card)',
    boxShadow: '0 10px 28px rgba(15, 23, 42, 0.08)',
  },
  coverFrame: {
    flex: '0 0 clamp(72px, 18vw, 112px)',
    alignSelf: 'flex-start',
    maxWidth: 112,
  },
  cover: {
    display: 'block',
    width: '100%',
    aspectRatio: '2 / 3',
    objectFit: 'cover',
    border: '1px solid var(--border)',
    borderRadius: 5,
    background: 'var(--muted)',
    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.16)',
  },
  coverFallback: {
    display: 'grid',
    width: '100%',
    aspectRatio: '2 / 3',
    placeItems: 'center',
    border: '1px solid var(--border)',
    borderRadius: 5,
    background: 'linear-gradient(145deg, var(--muted), var(--background))',
    color: 'var(--muted-foreground)',
    fontSize: 28,
    fontWeight: 650,
    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.14)',
  },
  body: {
    display: 'flex',
    minWidth: 0,
    flex: 1,
    flexDirection: 'column',
    gap: 8,
  },
  kicker: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    color: 'var(--muted-foreground)',
    fontSize: 12,
    lineHeight: 1.35,
  },
  sourceDot: {
    width: 4,
    height: 4,
    borderRadius: 4,
    background: 'var(--border)',
  },
  title: {
    minWidth: 0,
    fontSize: 19,
    fontWeight: 650,
    lineHeight: 1.3,
  },
  author: {
    color: 'var(--muted-foreground)',
    fontSize: 13,
    lineHeight: 1.4,
  },
  detailRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  detail: {
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '2px 6px',
    color: 'var(--muted-foreground)',
    fontSize: 12,
    lineHeight: 1.45,
  },
  note: {
    maxWidth: 680,
    maxHeight: '4.8em',
    overflow: 'hidden',
    color: 'var(--foreground)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  links: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    fontSize: 12,
    lineHeight: 1.4,
  },
  link: {
    color: 'var(--primary)',
    textDecoration: 'none',
  },
} satisfies Record<string, CSSProperties>

interface ReadwiseDocumentDecoratorViewProps {
  block: Block
  Inner: BlockRenderer
  innerProps: BlockRendererProps
}

const ReadwiseAuthorLine = ({block, authorId}: {block: Block; authorId: string}) => {
  const authorBlock = useMemo(() => block.repo.block(authorId), [block.repo, authorId])
  const authorData = useHandle(authorBlock, {selector: data => data ?? undefined})
  const label = decodeAliasLabel(authorData)
  const workspaceId = block.peek()?.workspaceId ?? authorData?.workspaceId
  const openAuthor = useOpenBlock({blockId: authorId, workspaceId})

  if (!label) return null

  return (
    <div style={readwiseDocumentStyles.author}>
      by{' '}
      {workspaceId ? (
        <a
          className="wikilink"
          data-alias={label}
          href={buildAppHash(workspaceId, authorId)}
          onClick={openAuthor}
          onMouseDown={event => event.stopPropagation()}
        >
          {label}
        </a>
      ) : label}
    </div>
  )
}

const ReadwiseDocumentDecoratorView = ({
  block,
  Inner,
  innerProps,
}: ReadwiseDocumentDecoratorViewProps) => {
  const meta = readwiseDocumentMeta(block)
  const source = cleanText(meta.source) ?? hostLabel(meta.sourceUrl)
  const category = cleanText(meta.category)
  const authorId = cleanText(meta.authorId)
  const note = cleanText(meta.documentNote)
  const sourceUrl = cleanText(meta.sourceUrl)
  const readwiseUrl = cleanText(meta.readwiseUrl)
  const asin = cleanText(meta.asin)
  const highlightCount = highlightCountLabel(meta.numHighlights)
  const lastHighlight = formatReadwiseDate(meta.lastHighlightAt)
  const cover = cleanText(meta.coverImageUrl)
  const fallbackTitle = block.peek()?.content
  const tags = meta.tags.map(cleanText).filter((tag): tag is string => Boolean(tag))

  return (
    <div style={readwiseDocumentStyles.card}>
      <div style={readwiseDocumentStyles.coverFrame} aria-hidden="true">
        {cover ? (
          <img
            alt=""
            src={cover}
            style={readwiseDocumentStyles.cover}
          />
        ) : (
          <div style={readwiseDocumentStyles.coverFallback}>
            {titleInitial(meta, fallbackTitle)}
          </div>
        )}
      </div>
      <div style={readwiseDocumentStyles.body}>
        {(category || source) && (
          <div style={readwiseDocumentStyles.kicker}>
            {category && <span>{category}</span>}
            {category && source && <span style={readwiseDocumentStyles.sourceDot}/>}
            {source && <span>{source}</span>}
          </div>
        )}
        <div style={readwiseDocumentStyles.title}>
          <Inner {...innerProps}/>
        </div>
        {authorId && <ReadwiseAuthorLine block={block} authorId={authorId}/>}
        {(highlightCount || lastHighlight || asin) && (
          <div style={readwiseDocumentStyles.detailRow}>
            {highlightCount && <span style={readwiseDocumentStyles.detail}>{highlightCount}</span>}
            {lastHighlight && <span style={readwiseDocumentStyles.detail}>Last highlight {lastHighlight}</span>}
            {asin && <span style={readwiseDocumentStyles.detail}>ASIN {asin}</span>}
          </div>
        )}
        {tags.length > 0 && (
          <div style={readwiseDocumentStyles.detailRow}>
            {tags.map(tag => (
              <span key={tag} style={readwiseDocumentStyles.detail}>{tag}</span>
            ))}
          </div>
        )}
        {note && <div style={readwiseDocumentStyles.note}>{note}</div>}
        {(sourceUrl || readwiseUrl) && (
          <div style={readwiseDocumentStyles.links}>
            {sourceUrl && (
              <a
                href={sourceUrl}
                rel="noreferrer"
                target="_blank"
                style={readwiseDocumentStyles.link}
                onClick={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
              >
                Source
              </a>
            )}
            {readwiseUrl && (
              <a
                href={readwiseUrl}
                rel="noreferrer"
                target="_blank"
                style={readwiseDocumentStyles.link}
                onClick={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
              >
                Readwise
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const readwiseDocumentDecoratorCache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorateReadwiseDocument: BlockContentDecorator = inner => {
  const existing = readwiseDocumentDecoratorCache.get(inner)
  if (existing) return existing

  const Decorated: BlockRenderer = props => (
    <ReadwiseDocumentDecoratorView block={props.block} Inner={inner} innerProps={props}/>
  )
  Decorated.displayName = 'WithReadwiseDocumentDecorator'
  readwiseDocumentDecoratorCache.set(inner, Decorated)
  return Decorated
}

const readwiseDocumentContentDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(READWISE_DOCUMENT_TYPE)) return null
  if (ctx.blockContext?.isBreadcrumb) return null
  return decorateReadwiseDocument
}

// ---------------------------------------------------------------------------
// reviewed-highlight decoration
//
// Marking a highlight reviewed is otherwise INVISIBLE — nothing else in the app
// reads `readwise:reviewed`. That made the review pass read as broken (press,
// nothing happens) and made the first visible feedback the *second* press, which
// falls through and turns the highlight into a todo. So: dim a reviewed
// highlight, and give it a check the user can click to un-review — the same
// affordance the properties-panel checkbox provides, without going and finding it.

const ReviewedHighlightDecorator = ({ block, Inner }: BlockRendererProps & { Inner: BlockRenderer }) => {
  // Reactive: a highlight can gain the type (first sync) or flip `reviewed` (the
  // latch, another device, the properties panel) while mounted.
  //
  // Decoded LENIENTLY, and that matters more here than on the keypress path:
  // `usePropertyValue` decodes through the strict codec, which THROWS on a
  // malformed cell — and this decorator is attached to every highlight, so a
  // `readwise:reviewed` of `"true"` from a raw import/sync/bridge write would
  // take out the whole block's render rather than just failing to decorate.
  const decorated = useHandle(block, {
    selector: (data: BlockData | null | undefined) => {
      if (!data) return false
      let types: readonly string[]
      try {
        types = getBlockTypes(data)
      } catch {
        return false
      }
      return types.includes(READWISE_HIGHLIGHT_TYPE) && readReviewed(data)
    },
  })

  if (!decorated) return <Inner block={block}/>

  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        aria-label="Mark highlight unreviewed"
        title="Reviewed — click to undo"
        data-block-interaction="ignore"
        disabled={block.repo.isReadOnly}
        className="mt-1 shrink-0 text-muted-foreground hover:text-foreground disabled:pointer-events-none"
        onClick={event => {
          event.stopPropagation()
          void block.set(reviewedProp, false)
        }}
      >
        {/* Inlined rather than imported: an installed extension resolves imports
            through the page importmap, which maps only `react`, `react-dom` and
            `@/` — a bare `lucide-react` specifier would pass the test here and
            404 on the user's device. */}
        <svg
          aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M3 8.5 6.5 12 13 4"/>
        </svg>
      </button>
      <div className="min-w-0 flex-1 text-muted-foreground">
        <Inner block={block}/>
      </div>
    </div>
  )
}

const decorateReviewedHighlight = cachedContentDecorator(
  ReviewedHighlightDecorator as ComponentType<{ block: Block, Inner: BlockRenderer }>,
  'WithReadwiseReviewedHighlight',
)

/** Keyed on the TYPE, not on `reviewed`: the decorator is attached to every
 *  highlight and the component decides per render, so flipping `reviewed` shows
 *  up immediately instead of waiting for the decorator set to be re-resolved. */
const readwiseReviewedContentDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(READWISE_HIGHLIGHT_TYPE)) return null
  if (ctx.blockContext?.isBreadcrumb) return null
  return decorateReviewedHighlight
}

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
  asin?: string
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
  return tags.map(t => t.name?.trim()).filter(Boolean).map(n => `#[[${n}]]`).join(' ')
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
  asin: b.asin ?? '',
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

const templateKeys = (line: string): string[] =>
  Array.from(line.matchAll(/\{([a-z_]+)\}/gi), match => match[1])

const propertyBackedLine = (line: string, propertyBackedKeys: ReadonlySet<string>): boolean => {
  const keys = templateKeys(line)
  if (keys.length === 0 || !keys.every(key => propertyBackedKeys.has(key))) return false
  // Only treat the line as fully property-backed (and therefore safe to drop,
  // since the managed properties now carry these values) when it is *nothing
  // but* those placeholders plus whitespace. A line like `My note: {note}` or
  // `Review prompt for {title}` carries literal text the properties don't
  // represent, so dropping it would lose the user's custom template output —
  // keep it and render it as a supplemental line instead.
  return line.replace(/\{[a-z_]+\}/gi, '').trim().length === 0
}

const renderSupplementalTemplateLines = (
  template: string,
  vars: Record<string, string>,
  propertyBackedKeys: ReadonlySet<string>,
): string[] => {
  return template
    .split('\n')
    .filter(line => !propertyBackedLine(line, propertyBackedKeys))
    .map(line => substitute(line, vars))
    .filter(line => line.trim().length > 0)
}

const BOOK_PROPERTY_TEMPLATE_KEYS = new Set([
  'author',
  'asin',
  'category',
  'cover_image_url',
  'document_note',
  'last_highlight_at',
  'num_highlights',
  'readwise_url',
  'source',
  'source_url',
  'tags',
  'title',
  'user_book_id',
])

const HIGHLIGHT_PROPERTY_TEMPLATE_KEYS = new Set([
  'color',
  'created_at',
  'highlight_id',
  'highlighted_at',
  'location',
  'location_type',
  'note',
  'readwise_url',
  'tags',
  'text',
  'updated_at',
])

const nonEmptyString = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text.length ? text : undefined
}

const tagNames = (tags: Array<{ name?: string }> | undefined): string[] =>
  (tags ?? [])
    .map(tag => tag.name?.trim())
    .filter((name): name is string => Boolean(name))

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const normalizedConfiguredTypeIds = (typeIds: readonly string[]): string[] =>
  [...new Set(typeIds.map(cleanText).filter((id): id is string => Boolean(id)))]

const addConfiguredTypes = async (
  tx: any,
  repo: any,
  blockId: string,
  typeIds: readonly string[],
  typeSnapshot: any,
) => {
  for (const typeId of normalizedConfiguredTypeIds(typeIds)) {
    if (!typeSnapshot.types.has(typeId)) continue
    await repo.addTypeInTx(tx, blockId, typeId, {}, typeSnapshot)
  }
}

type ManagedPropertyEntry<T = any> = readonly [PropertySchema<T>, T | undefined]

const applyManagedProperties = async (
  tx: any,
  blockId: string,
  schemas: readonly PropertySchema<any>[],
  entries: readonly ManagedPropertyEntry[],
) => {
  const row = await tx.get(blockId)
  if (!row) return

  const next = { ...row.properties }
  let changed = false
  const values = new Map<string, unknown>()
  for (const [schema, value] of entries) {
    if (value !== undefined) values.set(schema.name, schema.codec.encode(value))
  }

  for (const schema of schemas) {
    if (!values.has(schema.name)) {
      if (Object.prototype.hasOwnProperty.call(next, schema.name)) {
        delete next[schema.name]
        changed = true
      }
      continue
    }
    const encoded = values.get(schema.name)
    if (!sameJson(next[schema.name], encoded)) {
      next[schema.name] = encoded
      changed = true
    }
  }

  if (changed) await tx.update(blockId, { properties: next })
}

// ---------------------------------------------------------------------------
// document naming
//
// A Readwise title is very often a page the user ALREADY has, so claiming it
// trips `block_aliases_workspace_alias_unique` and takes the whole transaction
// that claimed it down with it — which is why naming is split out of the write.
//
// Kernel pages answer a contested name by yielding it entirely, which is right
// for a page reached by its id. A Readwise document is reached by NAME, so it
// takes a suffixed one instead and stays linkable. Its `content` is still the
// real title, which is what puts it in the state `DuplicateNameBanner` reads:
// the banner offers `alias.mergeCollision` in the reclaim direction, which
// folds the other page in and hands the real name back.

/** The alias the sync last claimed for this document. Recorded rather than
 *  inferred from the alias text: "did I write this?" is a fact the writer
 *  knows and a guess for anyone reading the string afterwards. Kept OUT of
 *  `DOCUMENT_PROPERTY_SCHEMAS`, which `applyManagedProperties` treats as a
 *  wipe list — a Readwise payload never carries this, so being in that list
 *  would delete it on every sync. */
const aliasClaimProp = seedProperty({
  seedKey: extensionPropertySeedKey('aliasClaim'),
  revision: 1,
  name: 'readwise:aliasClaim',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  // Bookkeeping, not something to edit: the ownership rule reads it to decide
  // whether an alias is the sync's to rewrite, so clearing this row by hand
  // makes the sync treat its own fallback as the user's and stop reconciling
  // it — the document then never reclaims its title.
  hidden: true,
})

/** The TITLE the user was shown when they chose to keep the fallback name —
 *  not a boolean. An answer is about one collision, and a document's title
 *  changes underneath it: Readwise re-titles A to B, B is taken too, and a
 *  boolean would carry the answer for A onto a conflict the user never saw.
 *  Storing what was accepted makes the comparison say so, and means nothing
 *  has to remember to clear it. */
const aliasAcceptedForProp = seedProperty({
  seedKey: extensionPropertySeedKey('aliasFallbackAcceptedFor'),
  revision: 1,
  name: 'readwise:aliasFallbackAcceptedFor',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  // Bookkeeping, not something to edit: the ownership rule reads it to decide
  // whether an alias is the sync's to rewrite, so clearing this row by hand
  // makes the sync treat its own fallback as the user's and stop reconciling
  // it — the document then never reclaims its title.
  hidden: true,
})

const FALLBACK_ALIAS_MARKER = 'Readwise'

/** Suffix probe depth. Two documents sharing a title is ordinary (a re-import,
 *  an article and the book it became); twenty is not, and past that claiming
 *  nothing beats an unbounded walk. */
const FALLBACK_ALIAS_SLOTS = 20

const fallbackAlias = (title: string, index: number): string =>
  `${title} (${FALLBACK_ALIAS_MARKER}${index === 1 ? '' : ` ${index}`})`

/** Is `name` there for the taking — unowned, or already this document's?
 *
 *  Every claimant, not `aliasLookup`. That form is `LIMIT 1` ordered by
 *  `created_at`, and co-claimants exist (the uniqueness trigger skips sync
 *  apply), so a question of the form "is anyone else holding this" reads FREE
 *  whenever the row it returns is this document — the older one. Claiming on
 *  that answer writes the bag straight into the trigger, and the book then
 *  fails on every run with the cursor pinned behind it. */
const aliasIsFree = async (
  tx: any,
  blockId: string,
  name: string,
  workspaceId: string,
): Promise<boolean> => {
  const claimants: readonly {id: string}[] = await tx.aliasClaimants(name, workspaceId)
  return claimants.every(row => row.id === blockId)
}

/** Is this whole bag the sync's to rewrite? Every entry is either the name it
 *  recorded claiming or the document's current content — `alias.sync`'s A3
 *  rule appends the latter while healing a content change, so it is in the bag
 *  without the sync having written it. Anything else is the user's, and the
 *  reconcile leaves the whole bag alone.
 *
 *  A document that predates `aliasClaim` has no claim recorded, and the only
 *  bag the sync could have left it is `[content]` — which the content leg
 *  already admits, so there is nothing to adopt. */
const isSyncOwnedAliasBag = (
  bag: readonly string[],
  claim: string | undefined,
  content: string,
): boolean => bag.every(alias => alias === claim || alias === content)

/** The alias this document may claim right now — the title when it is free,
 *  else the first free suffix, else `null` (claim nothing). */
const resolveDocumentAlias = async (
  tx: any,
  blockId: string,
  title: string,
  workspaceId: string,
): Promise<string | null> => {
  if (await aliasIsFree(tx, blockId, title, workspaceId)) return title
  for (let index = 1; index <= FALLBACK_ALIAS_SLOTS; index++) {
    const candidate = fallbackAlias(title, index)
    if (await aliasIsFree(tx, blockId, candidate, workspaceId)) return candidate
  }
  return null
}

/** Drop the name the document holds, so the transaction that RENAMES it can
 *  commit. Splitting the alias write out (below) is not enough on its own: A3
 *  reacts to the bag the row ALREADY has, and appends the new title to it. An
 *  empty bag is the one shape the rule skips.
 *
 *  Called only when the new title is contested — releasing on every rename
 *  would route around alias.sync rule 1, and with it
 *  `references.renameBacklinks`, leaving every `[[Old Title]]` in the graph
 *  pointing nowhere.
 *
 *  A bag the USER wrote is left alone, and a rename into a contested name then
 *  still fails for that one book — `runSync` reports it and carries on with the
 *  rest. Emptying someone's alias to get a title through is the worse trade. */
const releaseSyncOwnedAlias = async (
  tx: any,
  blockId: string,
  previousContent: string,
): Promise<void> => {
  const current: readonly string[] = await tx.getProperty(blockId, aliasesProp)
  if (current.length === 0) return
  const claim: string | undefined = await tx.getProperty(blockId, aliasClaimProp)
  if (!isSyncOwnedAliasBag(current, claim, previousContent)) return
  await tx.setProperty(blockId, aliasesProp, [])
}

/** Give up a fallback another row has come to co-hold, BEFORE the book's
 *  properties are written.
 *
 *  A properties rewrite re-inserts every alias in the bag under the uniqueness
 *  trigger, so one co-claimed entry rejects the whole transaction — taking the
 *  document, its highlights, and the naming step that would have moved it to a
 *  free suffix. The book then fails identically on every retry and holds
 *  `lastSyncedAt` behind it, which is the stall this branch exists to end.
 *
 *  Only the sync's own recorded claim, and only when it is not the content: an
 *  alias the USER added is theirs to keep even when contested (the banner is
 *  where that gets resolved), and dropping the alias equal to `content` is the
 *  shape the kernel reads as a rename. `ensureDocumentAlias` re-probes after
 *  the write and takes a free slot. */
const releaseCoClaimedFallback = async (
  repo: any,
  blockId: string,
  workspaceId: string,
): Promise<void> => {
  await repo.tx(async (tx: any) => {
    const doc = await tx.get(blockId)
    if (!doc || doc.deleted) return
    const claim: string | undefined = await tx.getProperty(blockId, aliasClaimProp)
    if (claim === undefined || claim === doc.content) return
    const current: readonly string[] = await tx.getProperty(blockId, aliasesProp)
    if (!current.includes(claim)) return
    const claimants: readonly {id: string}[] = await tx.aliasClaimants(claim, workspaceId)
    if (claimants.every(row => row.id === blockId)) return
    await tx.setProperty(blockId, aliasesProp, current.filter(alias => alias !== claim))
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: release a co-claimed name' })
}

/** Name the document, in a transaction of its OWN.
 *
 *  Never the one that rewrote `content`. `alias.sync`'s A3 rule heals a content
 *  change by APPENDING the new content to the alias bag, and when the new title
 *  is the contested one that append is refused and rolls the content rewrite —
 *  and everything else in the transaction — back with it. Probing for a free
 *  name does not help there: the probe's answer is not what A3 appends. Split
 *  out, the worst an alias collision can do is leave the document without the
 *  name it wanted, which is the state the duplicate-name banner exists for.
 *
 *  Re-run every time the document is synced, so a name that frees up (the
 *  rival renamed, deleted, or merged in) is taken back and the placeholder
 *  released. Not every sync: `runSync` walks the INCREMENTAL export, so a
 *  document Readwise has not touched since `lastSyncedAt` is not revisited and
 *  keeps its placeholder until it is. The merge the banner offers hands the
 *  name back directly and does not wait for that. */
const ensureDocumentAlias = async (
  repo: any,
  blockId: string,
  title: string,
  workspaceId: string,
  description: string,
): Promise<void> => {
  await repo.tx(async (tx: any) => {
    const current: readonly string[] = await tx.getProperty(blockId, aliasesProp)
    const claim: string | undefined = await tx.getProperty(blockId, aliasClaimProp)
    if (!isSyncOwnedAliasBag(current, claim, title)) return
    const claimable = await resolveDocumentAlias(tx, blockId, title, workspaceId)
    const next = claimable === null ? [] : [claimable]

    // Never write a bag that DROPS the document's own title while it holds it.
    // The kernel reads the disappearance of the alias that equals `content` as
    // a rename and rewrites content to follow, so re-parking a document that
    // already has its name would retitle the document to the placeholder and
    // take the real title off the block — along with the state the
    // duplicate-name banner reads, which is the way back.
    //
    // Nothing is lost by keeping it. The document reached this only by another
    // row claiming a name it already held, which sync apply permits, and a
    // shared name is what that banner exists to report.
    if (current.includes(title) && !next.includes(title)) return

    // Compare before writing: while a title stays contested this runs on every
    // sync, and an unguarded setProperty would rewrite the same bag each time.
    const bagUnchanged = current.length === next.length
      && current.every((alias, i) => alias === next[i])
    if (!bagUnchanged) await tx.setProperty(blockId, aliasesProp, next)
    const nextClaim = claimable ?? undefined
    if (claim !== nextClaim) await tx.setProperty(blockId, aliasClaimProp, nextClaim)

    // An acceptance is spent the moment the document actually holds its title:
    // that conflict is over, and a later collision on the SAME title is a
    // different one the user has not been asked about.
    //
    // This and the stored title are complementary, and deleting either brings
    // a bug back. The title covers a re-title onto ANOTHER taken name; this
    // covers the name being won back and lost again.
    if (claimable === title) {
      const acceptedFor: string | undefined = await tx.getProperty(blockId, aliasAcceptedForProp)
      if (acceptedFor !== undefined) await tx.unsetProperty(blockId, aliasAcceptedForProp)
    }
  }, { scope: ChangeScope.BlockDefault, description })
}

const lookupOrCreateAuthorPage = async (
  tx: any,
  repo: any,
  workspaceId: string,
  author: string | undefined,
  authorPageTypeIds: readonly string[],
  typeSnapshot: any,
): Promise<string | undefined> => {
  const name = nonEmptyString(author)
  if (!name) return undefined

  const existing = await tx.aliasLookup(name, workspaceId)
  if (existing && !existing.deleted) return existing.id

  const ensured = await ensureAliasTarget(tx, repo, name, workspaceId, typeSnapshot)
  if (ensured.inserted) {
    await addConfiguredTypes(tx, repo, ensured.id, authorPageTypeIds, typeSnapshot)
  }
  return ensured.id
}

const documentPropertyEntries = (
  book: BookRecord,
  authorPageId: string | undefined,
): ManagedPropertyEntry[] => {
  const tags = tagNames(book.book_tags)
  return [
    [userBookIdProp, String(book.user_book_id)],
    [titleProp, nonEmptyString(book.title)],
    [authorProp, authorPageId],
    [categoryProp, nonEmptyString(book.category)],
    [sourceProp, nonEmptyString(book.source)],
    [sourceUrlProp, nonEmptyString(book.source_url)],
    [readwiseUrlProp, nonEmptyString(book.readwise_url)],
    [coverImageUrlProp, nonEmptyString(book.cover_image_url)],
    [documentNoteProp, nonEmptyString(book.document_note)],
    [numHighlightsProp, optionalNumber(book.num_highlights)],
    [lastHighlightAtProp, nonEmptyString(book.last_highlight_at)],
    [asinProp, nonEmptyString(book.asin)],
    [tagsProp, tags.length ? tags : undefined],
  ]
}

const highlightPropertyEntries = (book: BookRecord, highlight: HighlightRecord): ManagedPropertyEntry[] => {
  const tags = tagNames(highlight.tags)
  return [
    [highlightIdProp, String(highlight.id)],
    [userBookIdProp, String(book.user_book_id)],
    [readwiseUrlProp, nonEmptyString(highlight.readwise_url)],
    [locationProp, nonEmptyString(highlight.location)],
    [locationTypeProp, nonEmptyString(highlight.location_type)],
    [colorProp, nonEmptyString(highlight.color)],
    [highlightedAtProp, nonEmptyString(highlight.highlighted_at)],
    [updatedAtProp, nonEmptyString(highlight.updated_at)],
    [createdAtProp, nonEmptyString(highlight.created_at)],
    [tagsProp, tags.length ? tags : undefined],
  ]
}

const notePropertyEntries = (highlight: HighlightRecord): ManagedPropertyEntry[] => [
  [noteForHighlightIdProp, String(highlight.id)],
]

const reviewDateIsoForSync = (now = new Date()): string => {
  const today = todayIso(now)
  const tomorrowStart = new Date(now)
  tomorrowStart.setHours(24, 0, 0, 0)
  const msUntilTomorrow = tomorrowStart.getTime() - now.getTime()
  return msUntilTomorrow <= REVIEW_ROLLOVER_BUFFER_MINUTES * 60_000
    ? addDaysIso(today, 1)
    : today
}

const ensureHighlightReviewState = async (
  tx: any,
  blockId: string,
  reviewDateBlockId: string,
) => {
  const row = await tx.get(blockId)
  if (!row) return

  const next = { ...row.properties }
  let changed = false
  if (!Object.prototype.hasOwnProperty.call(next, reviewDateProp.name)) {
    next[reviewDateProp.name] = reviewDateProp.codec.encode(reviewDateBlockId)
    changed = true
  }
  if (!Object.prototype.hasOwnProperty.call(next, reviewedProp.name)) {
    next[reviewedProp.name] = reviewedProp.codec.encode(false)
    changed = true
  }
  if (changed) await tx.update(blockId, { properties: next })
}

/** Lenient on purpose: a malformed `reviewed` cell reads as unreviewed, and the
 *  mark then overwrites it with a real boolean, so the cell self-heals. The
 *  propagating twin would make the keypress throw instead. */
const readReviewed = (data: Pick<BlockData, 'properties'>): boolean =>
  safeDecodeRowProperty(data, reviewedProp)

/** Marking a highlight reviewed is a one-way LATCH, not a cycle: the review pass
 *  asks "have I seen this yet", which only gets answered once. Once latched this
 *  returns false, so the press falls through to whatever the action normally
 *  does and the highlight stops being special.
 *
 *  Un-marking is deliberately not on this key (that would be the cycle again) —
 *  it's the `readwise:reviewed` checkbox in the block's properties.
 *
 *  Returns whether the press was consumed. */
const markHighlightReviewed = async (block: Block): Promise<boolean> => {
  const data = block.peek() ?? await block.load()
  if (!data || !getBlockTypes(data).includes(READWISE_HIGHLIGHT_TYPE)) return false
  if (readReviewed(data)) return false

  if (!block.repo.isReadOnly) {
    await block.set(reviewedProp, true)
  }
  return true
}

/** Wraps at DISPATCH time rather than rewriting the action definition, because
 *  the seam decides the ORDER. SRS decorates these same three actions from the
 *  dispatch seam, and a dispatch wrap always sits outside the effective action's
 *  handler — so as an `actionTransformsFacet` transform this could never run
 *  before SRS, whatever precedence either declared. On a block that is both a
 *  highlight and an SRS card the review mark should come first (it is the
 *  lighter action), which is what `READWISE_REVIEW_PRECEDENCE` buys below.
 *
 *  `await next(...)` rather than `return next(...)`: an async wrap cannot carry
 *  the inner sync `false` decline sentinel (`ActionHandlerResult` forbids
 *  `Promise<false>`), so awaiting it and resolving to `Promise<void>` is the
 *  documented discipline — same as the SRS twin. */
const decorateActionToMarkReadwiseReviewed = (
  actionId: string,
  context?: ActionContextType,
): ActionDispatchDecorator => ({
  actionId,
  ...(context ? { context } : {}),
  wrap: async (deps, trigger, next, dispatch) => {
    const block = (deps as BlockShortcutDependencies).block
    if (block && (await markHighlightReviewed(block))) return
    await next(deps, trigger, dispatch)
  },
})

/** Decorators fold ascending by precedence with the LOWEST innermost, so a value
 *  above SRS's (which registers at the default 0) puts the review mark outermost
 *  — it gets the press first, then declines once latched and hands it down. */
const READWISE_REVIEW_PRECEDENCE = 10

const readwiseSwipeRightDecorator: ActionDispatchDecorator =
  decorateActionToMarkReadwiseReviewed(SWIPE_RIGHT_BLOCK_ACTION_ID)

const readwiseTodoCycleDecorators: readonly ActionDispatchDecorator[] = [
  decorateActionToMarkReadwiseReviewed(
    TODO_CYCLE_ACTION_ID,
    ActionContextTypes.NORMAL_MODE,
  ),
  decorateActionToMarkReadwiseReviewed(
    EDIT_MODE_TODO_CYCLE_ACTION_ID,
    ActionContextTypes.EDIT_MODE_CM,
  ),
]

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
// alias conflicts, offered at sync time

/** A schema's `defaultValue` is what the app shows for an absent cell, but the
 *  codec is not given the chance to apply it — decoding `undefined` throws.
 *  Every read here is of a property the sync may never have written.
 *
 *  A malformed cell falls back too, rather than throwing. Sync apply can land a
 *  bag the codec rejects, and these reads drive a WORKSPACE-WIDE scan: one such
 *  row would otherwise stop every other document's conflict from ever being
 *  offered, silently, since the caller can only catch the whole scan.
 *
 *  BOUNDARY GUARD, not pinned: producing a bag the codec rejects means writing
 *  a shape only sync apply lands, and the raw-insert fixture here goes through
 *  the same trigger-maintained index the local path does. */
const storedProperty = <T,>(block: any, schema: { name: string; codec: any }, fallback: T): T => {
  const raw = block.properties?.[schema.name]
  if (raw === undefined) return fallback
  try {
    return schema.codec.decode(raw) as T
  } catch {
    return fallback
  }
}

export type AliasConflict = {
  documentId: string
  /** The name the document wants and cannot have — its content. */
  title: string
  /** The fallback it is parked on, or null when every slot was taken. */
  fallback: string | null
  rivalIds: readonly string[]
  rivalTitles: readonly string[]
  /** A rival that is itself a Readwise document. Merging one in is not
   *  durable: it keeps its deterministic id, and the next export update for
   *  that record finds the tombstone and restores it, recreating the collision
   *  and undoing half the merge. Those conflicts are keep-only. */
  managedRival: boolean
}

/** Documents that could not take their own name and whose user has not said to
 *  leave it that way.
 *
 *  Asked of the alias BAG rather than of the recorded claim: "does this
 *  document hold its own title" is the state the user sees, and it stays right
 *  for a document that predates the claim property or whose alias the user set
 *  themselves. A conflict needs a rival to merge with, so a document that
 *  simply has no alias is not one.
 *
 *  Deliberately NOT offered: a document that holds its name but shares it with
 *  a sync-applied co-claimant. `DuplicateNameBanner` already says so on the
 *  page, and catching it here would mean an alias lookup per document on every
 *  auto-sync tick, including the ticks with nothing to import. The bag check
 *  reads properties already in hand. */
export const unresolvedAliasConflicts = async (
  repo: any,
  workspaceId: string,
): Promise<AliasConflict[]> => {
  const documents: any[] = await repo.queryBlocks({
    workspaceId,
    types: [READWISE_DOCUMENT_TYPE],
  })
  const candidates = documents.filter(doc => {
    if (!doc.content) return false
    // Scoped to the title it was given for, so a re-title onto another taken
    // name is a new conflict rather than one already answered.
    if (storedProperty<string | undefined>(doc, aliasAcceptedForProp, undefined) === doc.content) {
      return false
    }
    return !storedProperty<readonly string[]>(doc, aliasesProp, []).includes(doc.content)
  })
  if (!candidates.length) return []

  return repo.tx(async (tx: any) => {
    const conflicts: AliasConflict[] = []
    for (const doc of candidates) {
      const rivals: any[] = (await tx.aliasClaimants(doc.content, workspaceId))
        .filter((row: any) => row.id !== doc.id)
      if (!rivals.length) continue
      conflicts.push({
        documentId: doc.id,
        title: doc.content,
        fallback: storedProperty<readonly string[]>(doc, aliasesProp, [])[0] ?? null,
        rivalIds: rivals.map((row: any) => row.id),
        rivalTitles: rivals.map((row: any) => row.content),
        managedRival: rivals.some((row: any) =>
          getBlockTypes(row).includes(READWISE_DOCUMENT_TYPE)),
      })
    }
    return conflicts
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: scan alias conflicts' })
}

/** "Keep this name" — stop offering the conflict the user was SHOWN.
 *
 *  `shownTitle` is what the dialog displayed, and the write is refused if the
 *  document no longer has it. A dialog can sit open across a sync that
 *  re-titles the document, and recording whatever is there at click time would
 *  answer a collision the user never saw — the click has to be about the thing
 *  it was made about, or about nothing. */
export const acceptFallbackAlias = async (
  repo: any,
  documentId: string,
  shownTitle: string,
): Promise<void> => {
  await repo.tx(async (tx: any) => {
    const doc = await tx.get(documentId)
    if (!doc || doc.deleted || doc.content !== shownTitle) return
    await tx.setProperty(documentId, aliasAcceptedForProp, shownTitle)
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: keep fallback name' })
}

/** Surface whatever is unresolved, without stealing focus. Failure here is
 *  swallowed: this is a notice about a sync, not part of one. */
const offerAliasConflicts = async (repo: any, workspaceId: string): Promise<void> => {
  try {
    const conflicts = await unresolvedAliasConflicts(repo, workspaceId)
    if (!conflicts.length) return
    const message = conflicts.length === 1
      ? `Readwise: “${truncate(conflicts[0].title, 40)}” is already a page name`
      : `Readwise: ${conflicts.length} documents could not use their name`
    showInfo(message, {
      action: {
        label: 'Resolve…',
        // Re-scanned rather than reusing the list the toast was built from:
        // the toast can sit for a whole auto-sync interval, and a conflict
        // resolved on the page in the meantime must not be offered again.
        onClick: () => { void (async () => {
          if (repo.activeWorkspaceId !== workspaceId) return
          const fresh = await unresolvedAliasConflicts(repo, workspaceId)
          if (!fresh.length) return
          await openDialog(ReadwiseAliasConflictDialog, { conflicts: fresh, workspaceId })
        })() },
      },
    })
  } catch (err) {
    console.error('[readwise] alias conflict scan failed', err)
  }
}

// ---------------------------------------------------------------------------
// sync

type SyncDeps = {
  repo: ReturnType<typeof useRepo> | any
}

const ROOT_ALIAS = 'Readwise Library'

/** Give the root its name back once whatever held it goes away. `addTypeInTx`
 *  seeds `initialValues` only where the property is ABSENT, so a root that
 *  yielded the name keeps the empty bag it was seeded with, and no later sync
 *  would fill it. Additive: an alias the user put on the root is not this
 *  function's to remove.
 *
 *  Its own transaction, and its failure is swallowed, because `ensureRoot` runs
 *  before `runSync`'s per-book isolation — anything that aborts here costs the
 *  whole export. `setProperty` rewrites the WHOLE bag, so an entry the root
 *  co-holds with a sync-applied row (sync apply skips the uniqueness trigger,
 *  so two live rows can hold one name) is re-inserted under that trigger and
 *  refused. A nameless root still works; a dead sync does not. */
const reclaimRootAlias = async (repo: any, rootId: string, workspaceId: string): Promise<void> => {
  try {
    await repo.tx(async (tx: any) => {
      const stored: readonly string[] = await tx.getProperty(rootId, aliasesProp)
      const claimable = await partitionClaimableAliases(tx, rootId, [ROOT_ALIAS], workspaceId)
      const missing = claimable.filter(alias => !stored.includes(alias))
      // Compared before writing: while the name stays contested this runs on
      // every sync.
      if (!missing.length) return
      await tx.setProperty(rootId, aliasesProp, [...stored, ...missing])
    }, { scope: ChangeScope.BlockDefault, description: 'readwise: name library root' })
  } catch (err) {
    console.error('[readwise] library root alias reclaim failed', err)
  }
}

/** Exported for `readwise.aliasConflict.test.tsx` — the library root yields its
 *  name the same way a document does, and that has to be pinned somewhere. */
export const ensureRoot = async (repo: any, workspaceId: string) => {
  const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: any) => {
    const existing = await tx.get(rootId)
    if (!existing || existing.deleted) {
      const roots = await tx.childrenOf(null, workspaceId)
      const lastKey = roots.length ? roots[roots.length - 1].orderKey : null
      await createOrRestoreTargetBlock(tx, {
        id: rootId,
        workspaceId,
        parentId: null,
        orderKey: keyBetween(lastKey, null),
        freshContent: ROOT_ALIAS,
      })
    }
    // Yielded rather than claimed, for the same reason a kernel page yields: a
    // user page already called "Readwise Library" would otherwise abort this
    // transaction and take the whole sync with it. The root is reached by its
    // deterministic id, so it loses nothing but the name.
    const rootAliases = await partitionClaimableAliases(tx, rootId, [ROOT_ALIAS], workspaceId)
    await repo.addTypeInTx(tx, rootId, PAGE_TYPE, { [aliasesProp.name]: rootAliases }, typeSnapshot)
    await repo.addTypeInTx(tx, rootId, READWISE_LIBRARY_TYPE, {}, typeSnapshot)
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: create root' })
  await reclaimRootAlias(repo, rootId, workspaceId)
  return rootId
}

const ensureHighlightsSection = async (
  tx: any,
  workspaceId: string,
  bookId: string,
  sectionId: string,
  metaIds: readonly string[],
): Promise<string> => {
  const children = await tx.childrenOf(bookId)
  const section = await tx.get(sectionId)
  const metaOrderKeys = metaIds
    .map(id => children.find((child: any) => child.id === id)?.orderKey)
    .filter((key): key is string => typeof key === 'string')
  const lower = metaOrderKeys.length ? metaOrderKeys[metaOrderKeys.length - 1] : null
  const upper = children.find((child: any) =>
    child.id !== sectionId &&
    !metaIds.includes(child.id) &&
    (lower === null || child.orderKey > lower))?.orderKey ?? null
  const targetOrderKey = keyBetween(lower, upper)

  if (!section || section.deleted) {
    await createOrRestoreTargetBlock(tx, {
      id: sectionId,
      workspaceId,
      parentId: bookId,
      orderKey: targetOrderKey,
      freshContent: HIGHLIGHTS_SECTION_CONTENT,
    })
    return sectionId
  }

  if (section.content !== HIGHLIGHTS_SECTION_CONTENT) {
    await tx.update(sectionId, { content: HIGHLIGHTS_SECTION_CONTENT })
  }

  const alreadyInPlace = section.parentId === bookId &&
    (lower === null || section.orderKey > lower) &&
    (upper === null || section.orderKey < upper)
  if (!alreadyInPlace) {
    await tx.move(sectionId, { parentId: bookId, orderKey: targetOrderKey })
  }

  return sectionId
}

/** Exported for `readwise.aliasConflict.test.tsx`, which drives one book through
 *  the real writer against a real repo — the alias fallback only means anything
 *  as the state it leaves in the DB. */
export const syncBookToBlocks = async (
  repo: any,
  workspaceId: string,
  rootId: string,
  book: BookRecord,
  pageTitleTemplate: string,
  bookTemplate: string,
  highlightTemplate: string,
  authorPageTypeIds: readonly string[],
  documentPageTypeIds: readonly string[],
  highlightTypeIds: readonly string[],
  reviewDateIso: string,
) => {
  const bookId = pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}`)
  const highlightsSectionId = pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}:highlights`)
  const bVars = bookVars(book)
  const title = substitute(pageTitleTemplate, bVars).trim() || `Readwise: ${book.title ?? book.user_book_id}`
  const supplementalLines = renderSupplementalTemplateLines(bookTemplate, bVars, BOOK_PROPERTY_TEMPLATE_KEYS)
  const typeSnapshot = repo.snapshotTypeRegistries()
  const highlights = (book.highlights ?? [])
    .filter(h => !h.is_deleted && h.text && h.text.trim().length)
  const reviewDateBlock = highlights.length
    ? await getOrCreateDailyNote(repo, workspaceId, reviewDateIso)
    : null

  // One undo entry for the two transactions below — the split is an alias-sync
  // constraint (see `ensureDocumentAlias`), not two things the user did.
  await repo.undoGroup(async (repo: any) => {
    await releaseCoClaimedFallback(repo, bookId, workspaceId)
    await repo.tx(async (tx: any) => {
      // 1. document page
      const existing = await tx.get(bookId)
      if (!existing || existing.deleted) {
        const siblings = await tx.childrenOf(rootId)
        const firstKey = siblings.length ? siblings[0].orderKey : null
        await createOrRestoreTargetBlock(tx, {
          id: bookId,
          workspaceId,
          parentId: rootId,
          orderKey: keyBetween(null, firstKey),
          freshContent: title,
        })
      } else if (existing.content !== title) {
        if (!await aliasIsFree(tx, bookId, title, workspaceId)) {
          await releaseSyncOwnedAlias(tx, bookId, existing.content)
        }
        await tx.update(bookId, { content: title })
      }
      // No alias in `initialValues`: naming the document is `ensureDocumentAlias`'s
      // job, in a transaction this one must not share.
      await repo.addTypeInTx(tx, bookId, PAGE_TYPE, {}, typeSnapshot)
      await repo.addTypeInTx(tx, bookId, READWISE_DOCUMENT_TYPE, {}, typeSnapshot)
      await addConfiguredTypes(tx, repo, bookId, documentPageTypeIds, typeSnapshot)
      const authorPageId = await lookupOrCreateAuthorPage(
        tx,
        repo,
        workspaceId,
        book.author,
        authorPageTypeIds,
        typeSnapshot,
      )
      await applyManagedProperties(tx, bookId, DOCUMENT_PROPERTY_SCHEMAS, documentPropertyEntries(book, authorPageId))

      // 2. supplemental template children. Property-backed template lines are
      //    intentionally omitted here because their values live on the
      //    Readwise document type.
      const bookKids = await tx.childrenOf(bookId)
      const metaIds = supplementalLines.map((_, i) =>
        pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}:meta:${i}`))

      // Template lines sit at the top of the book page, before any other children.
      const firstNonMetaKey = bookKids.find((k: any) => !metaIds.includes(k.id))?.orderKey ?? null
      const metaKeys = keysBetween(null, firstNonMetaKey, supplementalLines.length || 1)

      for (let i = 0; i < supplementalLines.length; i++) {
        const id = metaIds[i]
        const content = supplementalLines[i]
        const orderKey = metaKeys[i]
        const existingMetaBlock = await tx.get(id)
        if (!existingMetaBlock || existingMetaBlock.deleted) {
          await createOrRestoreTargetBlock(tx, {
            id, workspaceId, parentId: bookId, orderKey, freshContent: content,
          })
        } else {
          if (existingMetaBlock.content !== content) {
            await tx.update(id, { content })
          }
        }
      }
      // 3. highlights live under a deterministic sub-bullet on the document
      //    page, with notes still nested under their highlight.
      if (!highlights.length) return

      await ensureHighlightsSection(tx, workspaceId, bookId, highlightsSectionId, metaIds)

      const sectionKids = await tx.childrenOf(highlightsSectionId)
      const lastHighlightKey = sectionKids.length ? sectionKids[sectionKids.length - 1].orderKey : null
      const newHighlightKeys = keysBetween(lastHighlightKey, null, highlights.length || 1)
      let nextNewHighlightKey = 0

      for (let i = 0; i < highlights.length; i++) {
        const h = highlights[i]
        const hId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}`)
        const hVars = highlightVars(h)
        const hLines = renderTemplateLines(highlightTemplate, hVars)
        const hContent = hLines[0] ?? (h.text ?? '')
        const noteLines = renderSupplementalTemplateLines(
          highlightTemplate.split('\n').slice(1).join('\n'),
          hVars,
          HIGHLIGHT_PROPERTY_TEMPLATE_KEYS,
        )
        const noteText = nonEmptyString(h.note)

        const existingH = await tx.get(hId)
        if (!existingH || existingH.deleted) {
          await createOrRestoreTargetBlock(tx, {
            id: hId,
            workspaceId,
            parentId: highlightsSectionId,
            orderKey: newHighlightKeys[nextNewHighlightKey++],
            freshContent: hContent,
          })
        } else {
          if (existingH.content !== hContent) {
            await tx.update(hId, { content: hContent })
          }
        }
        await repo.addTypeInTx(tx, hId, READWISE_HIGHLIGHT_TYPE, {}, typeSnapshot)
        await addConfiguredTypes(tx, repo, hId, highlightTypeIds, typeSnapshot)
        await applyManagedProperties(tx, hId, HIGHLIGHT_PROPERTY_SCHEMAS, highlightPropertyEntries(book, h))
        if (reviewDateBlock) {
          await ensureHighlightReviewState(tx, hId, reviewDateBlock.id)
        }

        // a single deterministic note child
        const noteId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}:note`)
        const extraLines = [noteText, ...noteLines].filter(s => s && s.trim().length)
        const noteBlock = await tx.get(noteId)
        if (extraLines.length === 0) {
          if (noteBlock) await tx.delete(noteId)
        } else {
          const noteContent = extraLines.join('\n')
          if (!noteBlock || noteBlock.deleted) {
            const hKids = await tx.childrenOf(hId)
            const lastHKid = hKids.length ? hKids[hKids.length - 1].orderKey : null
            await createOrRestoreTargetBlock(tx, {
              id: noteId, workspaceId, parentId: hId,
              orderKey: keyBetween(lastHKid, null),
              freshContent: noteContent,
            })
          } else if (noteBlock.content !== noteContent) {
            await tx.update(noteId, { content: noteContent })
          }
          await repo.addTypeInTx(tx, noteId, READWISE_NOTE_TYPE, {}, typeSnapshot)
          await applyManagedProperties(tx, noteId, NOTE_PROPERTY_SCHEMAS, notePropertyEntries(h))
        }
      }
    }, { scope: ChangeScope.BlockDefault, description: `readwise: sync book ${book.user_book_id}` })

    await ensureDocumentAlias(
      repo, bookId, title, workspaceId,
      `readwise: name document ${book.user_book_id}`,
    )
  })
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
        action: { label: 'Connect', onClick: () => setSetupOpen(true) },
      })
    }
    return
  }
  const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
  const lastSynced = prefs.peekProperty(lastSyncedAtProp)
  const syncSince = prefs.peekProperty(syncSinceProp)
  const updatedAfter = lastSynced ?? syncSince?.toISOString() ?? null
  const pageTitleTemplate = prefs.get(pageTitleTemplateProp)
  const bookTemplate = prefs.get(bookTemplateProp)
  const highlightTemplate = prefs.get(highlightTemplateProp)
  const authorPageTypeIds = prefs.get(authorPageTypesProp)
  const documentPageTypeIds = prefs.get(documentPageTypesProp)
  const highlightTypeIds = prefs.get(highlightTypesProp)
  const reviewDateIso = reviewDateIsoForSync(new Date())

  let progress = silent ? null : showProgress('Readwise: fetching…')
  try {
    const rootId = await ensureRoot(repo, workspaceId)
    let pageCursor: string | null = null
    let bookCount = 0
    let highlightCount = 0
    let syncedHighlightCount = 0
    const failed: string[] = []
    do {
      const { results, nextPageCursor } = await fetchExportPage(token, updatedAfter, pageCursor)
      pageCursor = nextPageCursor
      for (const book of results) {
        bookCount++
        const bookHighlights = (book.highlights ?? []).length
        highlightCount += bookHighlights
        if (!progress) progress = showProgress('Readwise: syncing…')
        progress.update(`Readwise: ${bookCount} books, ${highlightCount} highlights…`)
        // Per book: one document that will not write must not cost the user
        // every book after it in the export.
        try {
          await syncBookToBlocks(
            repo, workspaceId, rootId, book,
            pageTitleTemplate, bookTemplate, highlightTemplate,
            authorPageTypeIds, documentPageTypeIds, highlightTypeIds, reviewDateIso,
          )
          syncedHighlightCount += bookHighlights
        } catch (err) {
          failed.push(nonEmptyString(book.title) ?? `#${book.user_book_id}`)
          console.error('[readwise] book sync failed', book.user_book_id, err)
        }
      }
    } while (pageCursor)

    // The cursor only advances on a clean pass: it is the only thing that
    // brings a failed book back, and moving it past one that did not land
    // would drop that book until Readwise happens to touch it again.
    if (failed.length === 0) await prefs.set(lastSyncedAtProp, new Date().toISOString())

    // Counted from what landed, not from what was fetched — a report that
    // includes a failed book's highlights is a report that lied.
    // Offered on EVERY sync, the silent ones too, and re-offered until the user
    // merges or keeps: a document parked on a fallback name is a state nothing
    // else resolves on its own, and the auto-sync path is the one most users
    // are on. A toast rather than the dialog itself, because a background sync
    // must not put a modal over whatever is being typed.
    await offerAliasConflicts(repo, workspaceId)

    const synced = `Readwise: synced ${bookCount - failed.length} book(s), ${syncedHighlightCount} highlight(s)`
    if (failed.length === 0) {
      progress?.done(bookCount === 0 ? undefined : synced)
    } else {
      const message = `${synced} — ${failed.length} failed (${truncate(failed.join(', '), 80)}). Retrying next sync.`
      // Reported on the silent syncs too. `silent` suppresses SUCCESS chatter
      // from the auto-sync tick; a failure is not chatter. A failed book holds
      // `lastSyncedAt`, so staying quiet would let one book stall the library
      // and widen the re-fetch window on every tick with nothing to see — and
      // the auto-sync path is the one most users are on. Named books rather
      // than a count, because resolving one starts with knowing which.
      if (progress) progress.fail(message)
      else showError(message)
    }
  } catch (err: any) {
    if (progress) {
      progress.fail(`Readwise sync failed: ${err?.message ?? err}`)
    } else if (!silent) {
      showError(`Readwise sync failed: ${err?.message ?? err}`)
    }
  }
}

// ---------------------------------------------------------------------------
// setup dialog (one-time token entry, plus disconnect)

/** The sync-time offer: for each document that could not take its own name,
 *  merge the page holding it in, or keep the fallback.
 *
 *  Merging goes through `mergeAliasCollision`, the same call the duplicate-name
 *  banner makes, so the UI deletion refusal, the panel retargeting and the
 *  refusal messages are one implementation rather than two. */
const ReadwiseAliasConflictDialog = ({
  conflicts: initial, workspaceId, resolve,
}: DialogContextProps<void> & {
  conflicts: readonly AliasConflict[]
  /** The workspace these conflicts were found in. Carried to be CHECKED, not
   *  to be written against: a merge dispatches through the repo's ambient
   *  workspace and read-only state, so carrying the id does not carry the
   *  write context with it. If they diverge the only safe move is to refuse. */
  workspaceId: string
}) => {
  const repo = useRepo()
  const [pending, setPending] = useState<readonly AliasConflict[]>(initial)
  const [busy, setBusy] = useState<string | null>(null)

  const done = (documentId: string) => {
    const rest = pending.filter(c => c.documentId !== documentId)
    setPending(rest)
    if (!rest.length) resolve()
  }

  /** Re-checked inside each action rather than once when the dialog opened —
   *  the switch can happen while the deletion preflight is on screen. */
  const inWorkspace = (): boolean => {
    if (repo.activeWorkspaceId === workspaceId) return true
    showError('Switch back to the workspace these documents are in to resolve them.')
    resolve()
    return false
  }

  const merge = async (conflict: AliasConflict) => {
    if (!inWorkspace()) return
    setBusy(conflict.documentId)
    try {
      const merged = await mergeAliasCollision(repo, {
        intoId: conflict.documentId,
        rivalIds: conflict.rivalIds,
        alias: conflict.title,
        workspaceId,
      })
      // A refusal already explained itself in a toast, and the conflict is
      // still live — leave the row so it can be tried again or kept.
      if (merged) done(conflict.documentId)
    } finally {
      setBusy(null)
    }
  }

  const keep = async (conflict: AliasConflict) => {
    if (!inWorkspace()) return
    setBusy(conflict.documentId)
    try {
      await acceptFallbackAlias(repo, conflict.documentId, conflict.title)
      done(conflict.documentId)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) resolve() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Readwise: names already taken</DialogTitle>
          <DialogDescription>
            {pending.length === 1
              ? 'A page already uses this name, so the imported document is filed under another one.'
              : 'Pages already use these names, so the imported documents are filed under others.'}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          {pending.map(conflict => (
            <div key={conflict.documentId} className='flex flex-col gap-1'>
              <div>
                <strong>{truncate(conflict.title, 60)}</strong>
                {conflict.fallback
                  ? <span style={{ color: 'var(--muted-foreground)' }}>
                      {' '}— filed as “{truncate(conflict.fallback, 60)}”
                    </span>
                  : <span style={{ color: 'var(--muted-foreground)' }}> — filed without a name</span>}
              </div>
              <div style={{ color: 'var(--muted-foreground)' }}>
                {conflict.rivalIds.length === 1
                  ? `“${truncate(conflict.rivalTitles[0] ?? conflict.title, 60)}” has the name`
                  : `${conflict.rivalIds.length} other pages have the name`}
              </div>
              {conflict.managedRival && (
                <div style={{ color: 'var(--muted-foreground)' }}>
                  That page is a Readwise document too, so merging it would not
                  stick — the next sync brings it back. Rename one of them in
                  Readwise instead.
                </div>
              )}
              <div className='flex gap-2'>
                {!conflict.managedRival && (
                  <Button
                    size='sm'
                    onClick={() => merge(conflict)}
                    disabled={busy !== null}
                  >Merge that page in</Button>
                )}
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => keep(conflict)}
                  disabled={busy !== null}
                >Keep this name</Button>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => resolve()} disabled={busy !== null}>
            Later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ReadwiseSetupDialog = () => {
  const repo = useRepo()
  const open = useSyncExternalStore(subscribeSetupOpen, () => setupOpen)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  // Clear any stale token entry each time the dialog opens.
  useEffect(() => {
    if (open) setToken('')
  }, [open])

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
      setSetupOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setSetupOpen}>
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
          <Button variant='ghost' onClick={() => setSetupOpen(false)} disabled={saving}>Cancel</Button>
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
            onClick={() => setSetupOpen(true)}
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
  handler: () => setSetupOpen(true),
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
// review backlog
//
// `readwise:review_date` schedules a highlight's first review onto one daily
// note, and the reviewed latch marks it done. That works per-day — the ref is
// indexed, so the day's highlights show in that daily note's linked references
// — but nothing rolls the MISSED days up, so a highlight scheduled three weeks
// ago is only reachable by navigating back to a date you'd have to know about.
// This page is that roll-up. It is a VIEW, not a reschedule: nothing here
// rewrites `review_date`, so the record of when something was scheduled (and
// the reference index built on it) stays intact.

// The three named exports below are this section's TESTABLE SEAM. Everything
// else in the file is reached only through the default contribution list, but
// the backlog's whole value is "which highlights does it show, in what order,
// and what happens when you mark one" — and asserting that through
// `DefaultBlockRenderer` would mean standing up the entire renderer stack to
// test a query, a grouping and a `useState`. See readwise.backlog.test.tsx.

const REVIEW_BACKLOG_TYPE = 'readwise-review-backlog'
/** Fresh uuid-v5 namespace, so the backlog is a per-workspace singleton on one
 *  deterministic row: reopening it reuses the same block rather than spawning a
 *  new page each time. Must not collide with any other kernel page's. */
const REVIEW_BACKLOG_NS = 'd23b647e-9eb2-41fa-b672-12e75987c60d'
const REVIEW_BACKLOG_ALIAS = 'Readwise Review'
const OPEN_REVIEW_BACKLOG_ACTION_ID = 'readwise.open-review-backlog'

const readwiseReviewBacklogType = seedType({
  seedKey: extensionTypeSeedKey('review-backlog'),
  revision: 1,
  id: REVIEW_BACKLOG_TYPE,
  label: 'Readwise review backlog',
  // Plumbing for the renderer's `canRender`, not something to tag blocks with.
  hideFromCompletion: true,
})

const getOrCreateReviewBacklog = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: REVIEW_BACKLOG_NS,
    alias: REVIEW_BACKLOG_ALIAS,
    markerType: REVIEW_BACKLOG_TYPE,
  })

/** Highlights scheduled for today or earlier that haven't been marked reviewed.
 *
 *  `exclude` rather than `match {reviewed: false}` is deliberate: SQL equality
 *  never matches a NULL cell, so a match would silently drop every highlight
 *  whose `reviewed` property was never written — a pre-latch import, or a row
 *  that arrived raw over sync. Same shape and cost, survives more. */
export const buildUnreviewedHighlightsQuery = (
  workspaceId: string,
  now?: Date,
): TypedBlockQuery => ({
  workspaceId,
  types: [READWISE_HIGHLIGHT_TYPE],
  where: dueByDailyNoteRef(reviewDateProp.name, now),
  exclude: [{ scope: 'self', where: { [reviewedProp.name]: true } }],
  order: 'created-asc',
})

/** Shared query builder, so the rows hook and the readiness hook observe the
 *  exact same typed-blocks handle rather than opening two. */
const useUnreviewedHighlightsQuery = (workspaceId: string): TypedBlockQuery => {
  // Drives the cutoff off today's local midnight, which advances overnight, so
  // a backlog left open past midnight picks up the new day instead of staying
  // pinned to yesterday's boundary.
  const startOfToday = useStartOfToday()
  return useMemo(
    () => buildUnreviewedHighlightsQuery(workspaceId, new Date(startOfToday)),
    [workspaceId, startOfToday],
  )
}

const useUnreviewedHighlights = (workspaceId: string): BlockData[] =>
  useBlockQuery(useUnreviewedHighlightsQuery(workspaceId))

/** Whether the query has produced a result yet, as opposed to still loading.
 *  `useBlockQuery` reports `[]` for both, so "nothing to review" and "haven't
 *  looked yet" are indistinguishable without this. The handle's data is
 *  `undefined` until the first resolve, then an array. Shares the handle with
 *  `useUnreviewedHighlights`, so it costs no extra query. */
const useUnreviewedHighlightsReady = (workspaceId: string): boolean => {
  const repo = useRepo()
  const query = useUnreviewedHighlightsQuery(workspaceId)
  return useHandle(repo.query.typedBlocks(query), {
    selector: data => data !== undefined,
  }) as boolean
}

/** The count alone, aggregated in SQLite rather than by materialising rows.
 *
 *  `core.typedBlockCount` shares the membership semantics, candidate set and
 *  invalidation of the list query — it is the same question with a different
 *  projection — so the two never disagree. Worth the separate handle for the
 *  surfacing badges, which want a number and would otherwise hold every row in
 *  the backlog to render it. `undefined` until the first resolve, which is the
 *  readiness signal these callers need anyway. */
const useUnreviewedHighlightCount = (workspaceId: string): number | undefined => {
  const repo = useRepo()
  const query = useUnreviewedHighlightsQuery(workspaceId)
  // Identity selector: the handle's whole value IS the number, so there is
  // nothing narrower to project.
  return useHandle(repo.query.typedBlockCount(query), {selector: data => data}) as number | undefined
}

/** Ids in the order they were first seen this session, never dropped.
 *
 *  Marking a highlight reviewed takes it out of the live query. Rendering the
 *  live list directly would make the row vanish and everything below it jump up
 *  under the cursor — which is the problem SRS review answers with a frozen
 *  queue, a persisted index, a day-rollover invalidation and a reconcile pass.
 *  None of that is needed here: the reviewed highlight stays where it is and
 *  dims (the reviewed content decorator does that), so "where was I" is
 *  answered by the screen.
 *
 *  This keeps IDS, not row snapshots. That is the whole design: an id has no
 *  staleness semantics, so there is nothing to reconcile. Everything else —
 *  which document a highlight groups under, whether it still exists, whether it
 *  is still a highlight — is read live from the block at render time, and can
 *  therefore never disagree with the database. The earlier snapshot-keeping
 *  version had to answer "did this row leave because it was reviewed, or
 *  deleted, or untagged, or rescheduled?", and got it wrong four separate ways.
 *
 *  The merge is APPEND-ONLY, which is what makes an unresolved handle harmless.
 *  `useBlockQuery` reports `[]` both while loading and when genuinely empty,
 *  and the day rollover changes the query key — so a snapshot-keeping version
 *  needed an explicit readiness gate to avoid reading "loading" as "everything
 *  left the query" and emptying the list at midnight. Here nothing is ever
 *  removed by reconciliation, so there is no such reading to get wrong.
 *  Departures are handled where they belong: `groupHighlightIds` simply doesn't
 *  render an id whose block is gone. */
export const useStickyIds = (
  liveIds: readonly string[],
): readonly [readonly string[], () => void] => {
  const [sticky, setSticky] = useState<readonly string[]>(liveIds)
  const merged = useMemo(() => {
    const known = new Set(sticky)
    const additions = liveIds.filter(id => !known.has(id))
    return additions.length === 0 ? sticky : [...sticky, ...additions]
  }, [sticky, liveIds])
  // Converge during render (React's "adjust state while rendering" path) so the
  // first paint after a query result already includes the new ids.
  if (merged !== sticky) setSticky(merged)
  const reset = useCallback(() => setSticky(liveIds), [liveIds])
  return [merged, reset]
}

const EMPTY_ANCESTORS: readonly Block[] = []

interface BacklogGroup {
  /** The highlights' shared parent — the document's "Highlights" section. */
  sectionId: string
  items: readonly string[]
}

/** Group ids by the highlights' CURRENT immediate parent, read live from each
 *  block rather than from a snapshot. Readwise files every highlight under its
 *  document's "Highlights" section, so the parent id is the document grouping —
 *  no ancestor query needed to work it out, and a highlight moved somewhere
 *  unexpected simply groups under wherever it actually lives now.
 *
 *  Reading live is also what makes an id set sufficient: a deleted or untagged
 *  block resolves to nothing and drops out here, with no "why did this leave
 *  the query" bookkeeping anywhere. Ids arrive in the query's `created-asc`
 *  order and Map insertion order preserves it, so groups come out oldest-first;
 *  since `review_date` is stamped at import, creation order tracks scheduling
 *  order. */
export const groupHighlightIds = (
  ids: readonly string[],
  read: (id: string) => BlockData | null | undefined,
): BacklogGroup[] => {
  const byParent = new Map<string, string[]>()
  for (const id of ids) {
    const data = read(id)
    if (!data || data.deleted) continue
    let types: readonly string[]
    try { types = getBlockTypes(data) } catch { continue }
    if (!types.includes(READWISE_HIGHLIGHT_TYPE)) continue
    const key = data.parentId ?? ''
    const bucket = byParent.get(key)
    if (bucket) bucket.push(id)
    else byParent.set(key, [id])
  }
  return [...byParent.entries()].map(([sectionId, items]) => ({ sectionId, items }))
}

/** How many seen ids left the live query BECAUSE they were reviewed.
 *
 *  Leaving is not the same as being done: a highlight also drops out when its
 *  review date is cleared or pushed into the future, and counting those as
 *  "done this session" would be a quietly wrong number next to a button that
 *  offers to clear them. Answered from current block state, like everything
 *  else derived from the id set. */
export const countReviewedDepartures = (
  seen: readonly string[],
  liveIds: readonly string[],
  read: (id: string) => BlockData | null | undefined,
): number => {
  const live = new Set(liveIds)
  let done = 0
  for (const id of seen) {
    if (live.has(id)) continue
    const data = read(id)
    if (!data || data.deleted) continue
    // Same admission rule as the grouping, deliberately: a block that lost its
    // highlight type isn't rendered, so counting it as a departure would leave
    // "N done" describing rows that aren't on screen.
    let types: readonly string[]
    try { types = getBlockTypes(data) } catch { continue }
    if (!types.includes(READWISE_HIGHLIGHT_TYPE)) continue
    if (readReviewed(data)) done++
  }
  return done
}

const BacklogGroupTitle = ({ documentBlock }: { documentBlock: Block }) => {
  const label = useHandle(documentBlock, {
    selector: (data: BlockData | null | undefined) => decodeAliasLabel(data ?? undefined),
  }) as string | undefined
  return <>{label ?? 'Untitled document'}</>
}

const BacklogGroupHeader = ({
  sectionBlock,
  ancestors,
  workspaceId,
  count,
}: {
  sectionBlock: Block
  ancestors: readonly Block[]
  workspaceId: string
  count: number
}) => {
  const openBlock = useBlockOpener()
  // Which block names this group? The section a highlight sits under IS the
  // answer, with ONE exception: the generated "Highlights" container, whose
  // own name says nothing, so the document above it speaks for it.
  //
  // Asking it that way round matters. Testing instead for "is the section a
  // readwise document" recognised only imported pages, so a highlight filed
  // under an ordinary page labelled and navigated to that page's PARENT.
  // The special case is the generated container, not the document type.
  //
  // Read reactively rather than by `peek`: on a cold open the section's own row
  // may not have resolved yet, and peeking would take the wrong branch and then
  // never re-render to correct it.
  const sectionIsGeneratedContainer = useHandle(sectionBlock, {
    selector: (data: BlockData | null | undefined) => {
      if (!data) return false
      if (data.content !== HIGHLIGHTS_SECTION_CONTENT) return false
      // A user-made page that happens to be called "Highlights" is still a
      // filing target — the generated one carries no types of its own.
      try { return getBlockTypes(data).length === 0 } catch { return false }
    },
  }) as boolean
  const documentBlock = sectionIsGeneratedContainer ? ancestors.at(-1) : sectionBlock

  return (
    <header className="flex items-baseline gap-2 border-b border-border/60 pb-1">
      {documentBlock
        ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline"
              onClick={event => openBlock(event, { blockId: documentBlock.id, workspaceId })}
            >
              <BacklogGroupTitle documentBlock={documentBlock}/>
            </button>
          )
        : (
            // Ancestors haven't resolved yet, or weren't prefetched for this
            // group: render it without a title rather than blocking its items.
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-foreground">
              Highlights
            </span>
          )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </header>
  )
}

const BacklogGroupSection = ({
  group,
  ancestors,
  workspaceId,
}: {
  group: BacklogGroup
  /** The section's own ancestor chain, root-first. */
  ancestors: readonly Block[]
  workspaceId: string
}) => {
  const repo = useRepo()
  const sectionBlock = group.sectionId ? repo.block(group.sectionId) : undefined

  // Each highlight's parents = the section's ancestors plus the section itself.
  // Handing these to the entry saves it firing its own ancestor query per row.
  // `sectionId` is '' for a highlight sitting at the workspace root (moved out
  // of its document); there is no section block to name.
  const itemParents = useMemo(
    () => (sectionBlock ? [...ancestors, sectionBlock] : EMPTY_ANCESTORS),
    [ancestors, sectionBlock],
  )

  return (
    <section className="space-y-1">
      {sectionBlock
        ? (
            <BacklogGroupHeader
              sectionBlock={sectionBlock}
              ancestors={ancestors}
              workspaceId={workspaceId}
              count={group.items.length}
            />
          )
        : (
            <header className="flex items-baseline gap-2 border-b border-border/60 pb-1">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-foreground">
                Unfiled highlights
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {group.items.length}
              </span>
            </header>
          )}
      {group.items.map(id => (
        <LazyBlockEntry
          key={id}
          block={repo.block(id)}
          initialParents={itemParents}
          scopeId={`readwise-backlog:${id}`}
        />
      ))}
    </section>
  )
}

const ReviewBacklogContent: BlockRenderer = ({ block }: BlockRendererProps) => {
  const repo = useRepo()
  const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const live = useUnreviewedHighlights(workspaceId)
  const ready = useUnreviewedHighlightsReady(workspaceId)
  const liveIds = useMemo(() => live.map(row => row.id), [live])
  const [seen, resetSeen] = useStickyIds(liveIds)

  // Everything below the id set is derived from CURRENT block state, so a
  // highlight that was moved, deleted or untagged since you saw it can never
  // render from a stale copy of itself.
  //
  // `live` is in the deps, not just `seen`: moving a highlight leaves the id
  // set untouched (same ids, same order) but changes the row the query returns,
  // and without that dependency the grouping would keep the old parent — the
  // one staleness the id-set design does NOT remove on its own.
  const groups = useMemo(
    () => groupHighlightIds(seen, id => repo.block(id).peek()),
    [seen, live, repo],
  )
  // Keyed on the section ids themselves rather than the `groups` array: groups
  // is rebuilt whenever the query re-resolves, and handing `useManyParents` a
  // fresh array each time would churn its handle for an unchanged id set.
  // No cap. I added one, and it was wrong twice over: the fallback it claimed
  // does not exist — `LazyBlockEntry` uses `initialParents` until the user
  // promotes a breadcrumb, so an uncapped group got NO breadcrumbs, ever — and
  // the limit it guarded is `MAX_VARIABLE_NUMBER=32766` (measured on a real
  // client, where 5000 bound parameters run fine), which needs 32k documents
  // carrying unreviewed highlights to reach. Trading certain breakage for an
  // unreachable one is a bad trade; if it ever is reached the query fails
  // loudly, which beats silently dropping every header past the cap.
  const sectionKey = groups
    .map(group => group.sectionId)
    .filter(Boolean)
    .join('\u0000')
  const sectionBlocks = useMemo(
    () => sectionKey.split('\u0000').filter(Boolean).map(id => repo.block(id)),
    [sectionKey, repo],
  )
  // ONE ancestor round-trip for every group, rather than one per group — this
  // is exactly the case `useManyParents` documents itself for.
  const ancestorsBySection = useManyParents(sectionBlocks)

  const shown = groups.reduce((n, group) => n + group.items.length, 0)
  // Gated on `ready`: while the handle is unresolved `live` is [], which would
  // otherwise read as "every row is done".
  const doneCount = ready ? countReviewedDepartures(seen, liveIds, id => repo.block(id).peek()) : 0

  if (shown === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl py-6 text-sm font-normal text-muted-foreground">
        {/* `useBlockQuery` reports [] while the handle is still unresolved, so
            without the readiness signal a cold open asserts "nothing to review"
            for a beat before the real list appears. */}
        {ready ? 'Nothing scheduled for review today or earlier.' : 'Loading…'}
      </div>
    )
  }

  return (
    // `text-base font-normal` is a RESET, not styling, and it is deliberately
    // redundant with the app: title typography now travels with the title TEXT
    // (`blockTitleText.ts`), so a surface mounted in the focal content slot no
    // longer inherits 24px/600. An installed extension runs against whatever
    // version is DEPLOYED, though, which lags this repo — so the surface states
    // its own baseline rather than trusting the frame around it. Without either,
    // the chrome here is fine (it sets its own sizes) but the highlights are
    // rendered by `BlockComponent` and set none, so they came out as headings.
    <div className="mx-auto w-full max-w-3xl space-y-6 py-4 text-base font-normal">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Readwise review</h2>
          <p className="text-sm text-muted-foreground">
            {shown - doneCount} unreviewed, scheduled today or earlier
            {doneCount > 0 ? ` · ${doneCount} done this session` : ''}
          </p>
        </div>
        {doneCount > 0 && (
          <Button variant="ghost" size="sm" onClick={resetSeen}>
            Clear done
          </Button>
        )}
      </div>

      {groups.map(group => (
        <BacklogGroupSection
          key={group.sectionId}
          group={group}
          ancestors={ancestorsBySection.get(group.sectionId) ?? EMPTY_ANCESTORS}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}
ReviewBacklogContent.displayName = 'ReadwiseReviewBacklogContent'

/** Keep the default block frame, swap the content area for the backlog. Same
 *  shape as the SRS review deck renderer and the block-type renderer. */
const ReviewBacklogRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={ReviewBacklogContent}
      EditContentRenderer={ReviewBacklogContent}
      // Filled with other blocks' rows, so this page's row spans all of them
      // rather than describing the page. Whatever reasons about row geometry
      // (the cursor-follows-scroll anchor) needs to know.
      contentShowsOtherBlocks
    />
  ),
  {
    canRender: ({ block }: BlockRendererProps): boolean => {
      const data = block.peek()
      if (!data) return false
      try {
        return getBlockTypes(data).includes(REVIEW_BACKLOG_TYPE)
      } catch {
        return false
      }
    },
    priority: () => 100,
  },
)
ReviewBacklogRenderer.displayName = 'ReadwiseReviewBacklogRenderer'

const openReviewBacklogAction = {
  id: OPEN_REVIEW_BACKLOG_ACTION_ID,
  description: 'Readwise: open review backlog',
  context: ActionContextTypes.GLOBAL,
  handler: async ({ uiStateBlock }: { uiStateBlock: any }) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const page = await getOrCreateReviewBacklog(repo, workspaceId)
    navigateFromGlobalCommand(repo, { blockId: page.id, workspaceId })
  },
}

// ---------------------------------------------------------------------------
// backlog surfacing
//
// Two places tell you the backlog exists: a left-sidebar entry, and a line on
// today's daily note — the page actually opened every day.
//
// Both read the count straight off the SAME subscribed query the backlog page
// uses. There is no cache here on purpose. An earlier version hand-rolled one
// (TTL, attempt stamps, generation-stamped snapshots, an in-flight flag, and an
// invalidation call at every site that writes `readwise:reviewed`) to avoid
// re-querying on a page opened constantly. That was the wrong trade twice over:
// the query costs ~4ms against a real library, and the kernel's loader already
// does structural-diff dedup, so a subscriber is NOT re-rendered by writes that
// leave the result unchanged. What the cache did buy was an open-ended
// obligation for every future writer of the property to remember to invalidate
// — which is how the same bug kept being found in a new call site.

const useBacklogCount = (workspaceId: string): number | null => {
  // Null, not 0, while unresolved: "nothing to review" and "haven't looked yet"
  // must not render the same. Rollover is handled inside the query hook, whose
  // cutoff is keyed on `useStartOfToday`.
  return useUnreviewedHighlightCount(workspaceId) ?? null
}

const ReviewBacklogSidebarSection = ({ closeSidebar }: { closeSidebar: () => void }) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId ?? ''
  const count = useBacklogCount(workspaceId)
  if (!count) return null

  return (
    <button
      type="button"
      className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
      onClick={() => {
        closeSidebar()
        void getOrCreateReviewBacklog(repo, workspaceId).then(page => {
          navigateFromGlobalCommand(repo, { blockId: page.id, workspaceId })
        })
      }}
    >
      <span className="min-w-0 flex-1 truncate">Readwise review</span>
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
        {count}
      </span>
    </button>
  )
}

const readwiseBacklogSidebarSection = {
  id: 'readwise.review-backlog',
  component: ReviewBacklogSidebarSection,
}

const DailyNoteBacklogHint = ({ block, Inner }: BlockRendererProps & { Inner: BlockRenderer }) => {
  const repo = useRepo()
  const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const count = useBacklogCount(workspaceId)
  // The ONLY place the date is decided, and it is reactive: `useStartOfToday`
  // advances at the rollover, so a note left open across midnight stops (or
  // starts) showing the hint on its own. Deciding this in the contribution
  // instead — as this used to — bakes in the date at resolve time, and
  // contributions are not re-resolved when time passes.
  const startOfToday = useStartOfToday()
  const isToday = block.id === dailyNoteBlockId(workspaceId, todayIso(new Date(startOfToday)))

  return (
    <>
      <Inner block={block}/>
      {isToday && !!count && (
        <button
          type="button"
          data-block-interaction="ignore"
          className="mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={event => {
            event.stopPropagation()
            void getOrCreateReviewBacklog(repo, workspaceId).then(page => {
              navigateFromGlobalCommand(repo, { blockId: page.id, workspaceId })
            })
          }}
        >
          {count} Readwise {count === 1 ? 'highlight' : 'highlights'} to review →
        </button>
      )}
    </>
  )
}

const decorateDailyNoteWithBacklogHint = cachedContentDecorator(
  DailyNoteBacklogHint as ComponentType<{ block: Block, Inner: BlockRenderer }>,
  'WithReadwiseBacklogHint',
)

/** STRUCTURAL only — type and focality, no date. A contribution is resolved
 *  once and never re-resolved as time passes, so any date decision made here is
 *  frozen at resolve time; both bugs this gate has had were exactly that. The
 *  component owns the date, reactively.
 *
 *  Mounting on every daily note is free now that the count is a subscription:
 *  every consumer shares one query handle, so a past note adds no query.
 *  `isTopLevel` still matters — it keeps the hint off breadcrumbs, embeds and
 *  backlink entries, where it would render once per occurrence. */
const readwiseDailyNoteBacklogDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(DAILY_NOTE_TYPE)) return null
  if (!ctx.isTopLevel) return null
  return decorateDailyNoteWithBacklogHint
}

// ---------------------------------------------------------------------------
// editor overrides

const connectedEditor = definePropertyEditorOverride(connectedHintProp, {
  label: 'Readwise',
  Editor: ConnectedEditor,
})
const lastSyncedEditor = definePropertyEditorOverride(lastSyncedAtProp, {
  label: 'Last synced',
  Editor: LastSyncedEditor,
})
const syncSinceEditor = definePropertyEditorOverride(syncSinceProp, {
  label: 'Initial sync start date',
})
const pageTitleEditor = definePropertyEditorOverride(pageTitleTemplateProp, {
  label: 'Page title template',
})
const bookTemplateEditor = definePropertyEditorOverride(bookTemplateProp, {
  label: 'Document supplemental template',
})
const highlightTemplateEditor = definePropertyEditorOverride(highlightTemplateProp, {
  label: 'Highlight template',
  Editor: TextareaEditor,
})
const autoSyncEditor = definePropertyEditorOverride(autoSyncIntervalProp, {
  label: 'Auto-sync interval (minutes; 0 = off)',
  Editor: NumberEditor,
})
const authorPageTypesEditor = definePropertyEditorOverride(authorPageTypesProp, {
  label: 'New author page types',
})
const documentPageTypesEditor = definePropertyEditorOverride(documentPageTypesProp, {
  label: 'Document page types',
})
const highlightTypesEditor = definePropertyEditorOverride(highlightTypesProp, {
  label: 'Highlight types',
})

// ---------------------------------------------------------------------------
// wiring

const source = 'readwise'

export default [
  typeSeedsFacet.of(readwisePrefsType, { source }),
  typeSeedsFacet.of(readwiseLibraryType, { source }),
  typeSeedsFacet.of(readwiseDocumentType, { source }),
  typeSeedsFacet.of(readwiseHighlightType, { source }),
  typeSeedsFacet.of(readwiseNoteType, { source }),
  typeSeedsFacet.of(readwiseReviewBacklogType, { source }),

  definitionSeedsFacet.of(lastSyncedAtProp, { source }),
  definitionSeedsFacet.of(syncSinceProp, { source }),
  definitionSeedsFacet.of(pageTitleTemplateProp, { source }),
  definitionSeedsFacet.of(bookTemplateProp, { source }),
  definitionSeedsFacet.of(highlightTemplateProp, { source }),
  definitionSeedsFacet.of(autoSyncIntervalProp, { source }),
  definitionSeedsFacet.of(authorPageTypesProp, { source }),
  definitionSeedsFacet.of(documentPageTypesProp, { source }),
  definitionSeedsFacet.of(highlightTypesProp, { source }),
  definitionSeedsFacet.of(connectedHintProp, { source }),
  definitionSeedsFacet.of(aliasClaimProp, { source }),
  definitionSeedsFacet.of(aliasAcceptedForProp, { source }),
  ...IMPORTED_PROPERTY_SCHEMAS.map(schema => definitionSeedsFacet.of(schema, { source })),

  propertyEditorOverridesFacet.of(connectedEditor, { source }),
  propertyEditorOverridesFacet.of(lastSyncedEditor, { source }),
  propertyEditorOverridesFacet.of(syncSinceEditor, { source }),
  propertyEditorOverridesFacet.of(pageTitleEditor, { source }),
  propertyEditorOverridesFacet.of(bookTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(highlightTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(autoSyncEditor, { source }),
  propertyEditorOverridesFacet.of(authorPageTypesEditor, { source }),
  propertyEditorOverridesFacet.of(documentPageTypesEditor, { source }),
  propertyEditorOverridesFacet.of(highlightTypesEditor, { source }),

  appMountsFacet.of({ id: 'readwise.setup-dialog', component: ReadwiseSetupDialog }, { source }),
  // `openDialog` is inert without DialogHost mounted (deduped by reference).
  dialogAppMountExtension,
  appEffectsFacet.of(autoSyncEffect, { source }),
  blockContentDecoratorsFacet.of(readwiseDocumentContentDecorator, { source }),
  blockContentDecoratorsFacet.of(readwiseReviewedContentDecorator, { source }),
  blockContentDecoratorsFacet.of(readwiseDailyNoteBacklogDecorator, { source }),
  leftSidebarSectionsFacet.of(readwiseBacklogSidebarSection, { source }),

  blockRenderersFacet.of(
    { id: 'readwiseReviewBacklog', renderer: ReviewBacklogRenderer },
    { source },
  ),

  actionsFacet.of(openSettingsAction, { source }),
  actionsFacet.of(syncNowAction, { source }),
  actionsFacet.of(connectAction, { source }),
  actionsFacet.of(openReviewBacklogAction, { source }),
  actionDispatchWrap(readwiseSwipeRightDecorator,
    { source, precedence: READWISE_REVIEW_PRECEDENCE }),
  ...readwiseTodoCycleDecorators.map(decorator =>
    actionDispatchWrap(decorator, { source, precedence: READWISE_REVIEW_PRECEDENCE })),
]
