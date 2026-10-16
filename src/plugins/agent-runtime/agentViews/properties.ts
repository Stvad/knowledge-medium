import type { Repo } from '@/data/repo'
import type { AnyPropertySchema, BlockData } from '@/data/api'
import { decodeRefId, decodeRefListIds, isRefCodec, isRefListCodec, memberCodecOf } from '@/data/api/codecs.js'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { isPropertyPanelHiddenProperty } from '@/components/propertyPanel/visibility.js'
import { boundDisplayId, displayIds } from './displayIds.ts'
import { boundLabels, charBoundary, clipLine, ellipsize, formatCount, oneLine, textHeadSql } from './text.ts'

export interface PropertyLine {
  name: string
  /** One-line display form: refs as `[[Title]] ^shortid`, dates as ISO, lists
   *  joined, structured values summarized. */
  value: string
  /** A ref property's target ids, exactly as stored, for the refs it titles
   *  (the first {@link MAX_REFS}, whether or not `value` had room to name
   *  them). The display form bounds ids; this does not. */
  refIds?: string[]
}

export interface PropertyView {
  /** At most {@link MAX_PROPERTIES}; `omitted` counts the rest. */
  visible: PropertyLine[]
  omitted: number
  /** Names the property panel hides (system, UI-state, declared hidden),
   *  bounded by {@link boundLabels}. */
  hidden: string[]
}

export type PropertyDetail = 'brief' | 'full'

/** Shown inline on an outline line before the rest collapse to `+N props`. */
export const BRIEF_PROPERTY_COUNT = 3
const BRIEF_VALUE_CHARS = 40
const FULL_VALUE_CHARS = 300
/** Names are user data too: an importer can write arbitrarily long ones. */
export const NAME_CHARS = 80
/** A property bag is bounded like content: an importer can write hundreds. */
const MAX_PROPERTIES = 50
const MAX_HIDDEN_NAMES = 20
const MAX_TYPES = 10
/** Refs titled and shown per property; a refList can hold thousands. */
const MAX_REFS = 20
/** A ref's label shows only with at least this much room beside its id. */
const MIN_REF_LABEL = 12
const SUMMARY_KEYS = 3

/** A list value is decoded from a head this long — more than any line can
 *  show — with its real length kept for the "+N more" count. Only for a
 *  codec that declares its array member-wise (`memberCodecOf`), or none: an
 *  atomic array encoding may need its tail, so that one is decoded whole. */
const MAX_DECODED_ITEMS = 100

export type Decoded =
  | {kind: 'refs', ids: string[], total: number}
  | {kind: 'value', value: unknown, total?: number}

export const decodeProperty = (schema: AnyPropertySchema | undefined, raw: unknown): Decoded => {
  const codec = schema?.codec
  const memberWise = codec === undefined || memberCodecOf(codec) !== undefined
  const total = Array.isArray(raw) && memberWise ? raw.length : undefined
  const head = memberWise && Array.isArray(raw) && raw.length > MAX_DECODED_ITEMS ? raw.slice(0, MAX_DECODED_ITEMS) : raw
  if (!codec) return {kind: 'value', value: head, total}
  if (isRefCodec(codec)) {
    const id = decodeRefId(codec, raw)
    return id ? {kind: 'refs', ids: [id], total: 1} : {kind: 'value', value: raw}
  }
  if (isRefListCodec(codec)) return {kind: 'refs', ids: decodeRefListIds(codec, head), total: total ?? 0}
  try {
    return {kind: 'value', value: codec.decode(head), total}
  } catch {
    return {kind: 'value', value: head, total}
  }
}

/** Property candidates decoded per block before the rest are only counted. */
const MAX_SCANNED = 200

/** A decoded value that renders as nothing — no refs, no value, an empty
 *  list, or a page's alias list holding just its title (the title is the line). */
export const isBlank = (decoded: Decoded, name: string, block: BlockData): boolean => {
  if (decoded.kind === 'refs') return decoded.total === 0
  const value = decoded.value
  if (value === null || value === undefined || value === '') return true
  if (!Array.isArray(value)) return false
  if (value.length === 0) return true
  return name === aliasesProp.name && value.length === 1 && value[0] === block.content.trim() && (decoded.total ?? 1) === 1
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const formatDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z')
}

const isListItem = (value: unknown): boolean => isScalar(value) || value instanceof Date

/** What a cut-off list ends with: the count of the items not shown. */
const moreSuffix = (left: number): string => `, …+${left} more`

/** Structured values (an SRS snapshot history, an importer's payload) are
 *  summarized, never dumped — they are what made raw outlines unreadable. A
 *  list is read only until its line is full: a list of records is told by
 *  its first item, a list of scalars is joined until it passes `budget`, and
 *  `total` (the undecoded list's length) counts what was never read. */
const formatValue = (value: unknown, budget: number, from = 0, total?: number): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDate(value)
  if (isScalar(value)) return String(value)
  if (Array.isArray(value)) {
    const count = total ?? value.length
    if (value.length > from && !isListItem(value[from])) return `[${count} items]`
    let joined = ''
    for (let index = from; index < value.length; index++) {
      const item: unknown = value[index]
      if (!isListItem(item)) return `${joined}${moreSuffix(count - index)}`
      const left = count - index - 1
      const separator = index > from ? ', ' : ''
      // Room for the count of what follows, so the line's own clip never cuts it off.
      const space = budget - joined.length - separator.length - (left > 0 ? moreSuffix(left).length : 0)
      const text = formatValue(item, budget)
      // An item that does not fit is counted, never cut — the last one too, so
      // the line's clip cannot take the end of a ref's id. Only a first item
      // is cut, to show something.
      if (text.length > space && (index > from || left > 0)) {
        if (index > from) return `${joined}${moreSuffix(count - index)}`
        return `${text.slice(0, charBoundary(text, Math.max(1, space - 1)))}…${moreSuffix(left)}`
      }
      joined += `${separator}${text}`
    }
    return count > value.length ? `${joined}${moreSuffix(count - value.length)}` : joined
  }
  if (typeof value === 'object') {
    // Enumerate only what is shown (plus one, to know there is more): an
    // importer's object can have hundreds of thousands of keys.
    const keys: string[] = []
    const keyChars = Math.floor(budget / (SUMMARY_KEYS + 1))
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      keys.push(key.length > keyChars ? `${key.slice(0, charBoundary(key, keyChars))}…` : key)
      if (keys.length > SUMMARY_KEYS) break
    }
    return `{${keys.slice(0, SUMMARY_KEYS).join(', ')}${keys.length > SUMMARY_KEYS ? ', …' : ''}}`
  }
  return String(value)
}

/** A plain name (`status`, `interval`, a user's own property) is the graph's
 *  shared vocabulary; a `namespace:`-prefixed one is a plugin's or importer's
 *  (extensions are asked to namespace theirs) — `matrix-event:id`,
 *  `roam:create/time`. The brief form inlines only the first kind and counts
 *  the second, so per-message importer metadata cannot crowd out the text. */
const isNamespaced = (name: string): boolean => name.includes(':')

export interface PropertyRenderer {
  /** The block's properties at the detail the renderer was made for. */
  view(block: BlockData): PropertyView
  /** Type labels for display (`todo`, a user type's name); an unknown
   *  user-type id is dropped rather than printed as a uuid. */
  typeLabels(block: BlockData): string[]
}

/** What a ref's title needs, projected at the database: the first alias and
 *  a bounded head of the content, never a whole (possibly huge) row. */
const TITLE_ROWS_SQL = `
  SELECT b.id AS id, b.workspace_id AS workspace_id,
         substr(json_extract(b.properties_json, '$.alias[0]'), 1, 400) AS alias,
         ${textHeadSql('b.content', 400)} AS content
    FROM json_each(?) j JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bind a renderer for a batch of blocks. Per block it picks the properties
 *  it can show — visible ones, plain names first, at most
 *  {@link MAX_PROPERTIES} — and decodes only those through the registry, then
 *  loads the titles of their referenced blocks in one query, so a ref renders
 *  as `[[Title]]` or quoted content, then its `^shortid`. A huge bag costs its names, not its decoding (a cost
 *  bound: decoding everything would render the same). Visibility
 *  is the property panel's rule (`isPropertyPanelHiddenProperty`), so an
 *  agent sees what the user sees. */
export const createPropertyRenderer = async (
  repo: Repo,
  blocks: readonly BlockData[],
  detail: PropertyDetail | 'none',
): Promise<PropertyRenderer> => {
  // Only what the detail can show is prepared: brief inlines the first few
  // plain names, full the first MAX_PROPERTIES, none nothing (type labels
  // still work). The rest are counted.
  const showable = detail === 'brief' ? BRIEF_PROPERTY_COUNT : detail === 'full' ? MAX_PROPERTIES : 0
  const schemas = repo.propertySchemas
  const overrides = repo.propertyEditorOverrides
  const definitions = repo.propertyDefinitions

  interface Prepared {
    shown: Array<{name: string, decoded: Decoded}>
    omitted: number
    hidden: string[]
  }
  const preparedByBlock = new Map<string, Prepared>()
  const refIds = new Set<string>()
  for (const block of showable > 0 ? blocks : []) {
    if (preparedByBlock.has(block.id)) continue
    const bag = block.properties ?? {}
    const plain: string[] = []
    const namespaced: string[] = []
    const hidden: string[] = []
    for (const name of Object.keys(bag)) {
      if (name === typesProp.name) continue
      if (isPropertyPanelHiddenProperty(name, schemas, overrides, definitions)) hidden.push(name)
      else (isNamespaced(name) ? namespaced : plain).push(name)
    }
    // Plain names first, so the cap can never crowd out the shared
    // vocabulary; brief shows plain names only.
    const visible = [...plain, ...namespaced]
    const candidates = detail === 'brief' ? plain : visible
    // Candidates are decoded in order until enough show; one whose DECODED
    // value is blank takes no slot — judged after decoding, since a codec may
    // encode a real value as '' or []. At most MAX_SCANNED are decoded (a cost
    // bound); the rest are counted, not read.
    const shown: Array<{name: string, decoded: Decoded}> = []
    let blank = 0
    let scanned = 0
    for (const name of candidates) {
      if (shown.length >= showable || scanned >= MAX_SCANNED) break
      scanned += 1
      const decoded = decodeProperty(schemas.get(name), bag[name])
      if (isBlank(decoded, name, block)) blank += 1
      else shown.push({name, decoded})
    }
    for (const {decoded} of shown) {
      if (decoded.kind === 'refs') decoded.ids.slice(0, MAX_REFS).forEach(id => refIds.add(id))
    }
    preparedByBlock.set(block.id, {shown, omitted: visible.length - shown.length - blank, hidden})
  }

  interface Title {
    workspaceId: string
    /** The page's first alias, or null for a block that has none. */
    alias: string | null
    content: string
  }
  const titles = new Map<string, Title>()
  if (refIds.size > 0) {
    const rows = await repo.db.getAll<{id: string, workspace_id: string, alias: unknown, content: string | null}>(
      TITLE_ROWS_SQL,
      [JSON.stringify([...refIds])],
    )
    for (const row of rows) {
      const alias = typeof row.alias === 'string' ? oneLine(row.alias) : ''
      titles.set(row.id, {workspaceId: row.workspace_id, alias: alias || null, content: oneLine(row.content ?? '')})
    }
  }
  const refShortIds = titles.size > 0 ? await displayIds(repo, titles.keys()) : new Map<string, string>()

  // A ref reads as its page's [[alias]] or its block's quoted content, then
  // the ^shortid that resolves to it. The id is what addresses the target —
  // content names nothing, and an alias two pages claim names the older one —
  // so the label gives way to it, never the reverse. References resolve within
  // a workspace, so another workspace's block stays a dangling ((id)) here, as
  // it is everywhere else.
  const refText = (id: string, workspaceId: string, budget: number): string => {
    const title = titles.get(id)
    if (title?.workspaceId !== workspaceId) return `((${boundDisplayId(id)}))`
    const shortId = refShortIds.get(id) ?? boundDisplayId(id)
    const label = title.alias ?? title.content
    if (!label) return `^${shortId}`
    const [open, close] = title.alias !== null ? ['[[', ']]'] : ['"', '"']
    const room = budget - shortId.length - 2 - open.length - close.length
    if (room < MIN_REF_LABEL) return `^${shortId}`
    return `${open}${ellipsize(label, room)}${close} ^${shortId}`
  }

  const display = (decoded: Decoded, block: BlockData, name: string, budget: number): string => {
    if (decoded.kind === 'refs') {
      // Each ref fits the space the list leaves its first item, beside the
      // count of the rest, so no cut can drop a ref's id.
      const space = budget - (decoded.total > 1 ? moreSuffix(decoded.total - 1).length : 0)
      const shown = decoded.ids.slice(0, MAX_REFS).map(id => refText(id, block.workspaceId, space))
      // A ref is shown whole or counted, never cut; when not even the first
      // fits (a long id beside the count), the property says how many it holds.
      if ((shown[0]?.length ?? 0) > space) {
        return decoded.total === 1 ? '[1 ref]' : `[${formatCount(decoded.total)} refs]`
      }
      // Joined like any list, so the count of the rest stays on the line.
      return formatValue(shown, budget, 0, decoded.total)
    }
    // A page's first alias is its title, already on the line; skipped in
    // place, since an alias list can be huge.
    if (name === aliasesProp.name && Array.isArray(decoded.value)) {
      return formatValue(decoded.value, budget, decoded.value[0] === block.content.trim() ? 1 : 0, decoded.total)
    }
    return formatValue(decoded.value, budget, 0, decoded.total)
  }

  return {
    view(block) {
      const prepared = preparedByBlock.get(block.id) ?? {shown: [], omitted: 0, hidden: []}
      const maxChars = detail === 'brief' ? BRIEF_VALUE_CHARS : FULL_VALUE_CHARS
      const visible: PropertyLine[] = []
      for (const {name, decoded} of prepared.shown) {
        const value = display(decoded, block, name, maxChars)
        if (value === '') continue
        visible.push({
          name: clipLine(name, NAME_CHARS).text,
          value: clipLine(value, maxChars).text,
          ...(decoded.kind === 'refs' ? {refIds: decoded.ids.slice(0, MAX_REFS)} : {}),
        })
      }
      const hidden = prepared.hidden
      return {
        visible,
        omitted: prepared.omitted,
        hidden: boundLabels(hidden, MAX_HIDDEN_NAMES, NAME_CHARS),
      }
    },
    typeLabels(block) {
      // Only a head of the stored list is read (a cost bound); the rest is
      // counted, not resolved.
      const raw = block.properties[typesProp.name]
      if (!Array.isArray(raw)) return []
      const labels = new Set<string>()
      const scanned = Math.min(raw.length, MAX_DECODED_ITEMS)
      for (let index = 0; index < scanned; index++) {
        const typeId: unknown = raw[index]
        if (typeof typeId !== 'string') continue
        const label = repo.types.get(typeId)?.label?.trim()
        if (label) labels.add(label)
        else if (!UUID_RE.test(typeId)) labels.add(typeId)
      }
      return boundLabels([...labels], MAX_TYPES, NAME_CHARS, labels.size + (raw.length - scanned))
    },
  }
}

/** `key:: value` pairs for one line, then the count of what the renderer
 *  left out. */
export const formatPropertyPairs = (lines: readonly PropertyLine[], omitted = 0): string => {
  const pairs = lines.map(line => `${line.name}:: ${line.value}`)
  if (omitted > 0) pairs.push(`+${omitted} props`)
  return pairs.join('  ')
}
