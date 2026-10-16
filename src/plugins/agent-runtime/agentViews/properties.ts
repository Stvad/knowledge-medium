import type { Repo } from '@/data/repo'
import type { AnyPropertySchema, BlockData } from '@/data/api'
import { decodeRefId, decodeRefListIds, isRefCodec, isRefListCodec } from '@/data/api/codecs.js'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { isPropertyPanelHiddenProperty } from '@/components/propertyPanel/visibility.js'
import { labelForBlockData, readTypeIds } from '@/utils/linkTargetAutocomplete.js'
import { parseBlockRow } from '@/data/blockSchema.js'
import type { BlockRow } from '@/data/blockSchema.js'
import { boundLabels, charBoundary, clipLine, oneLine } from './text.ts'

export interface PropertyLine {
  name: string
  /** One-line display form: refs as `[[Title]]`, dates as ISO, lists joined,
   *  structured values summarized. */
  value: string
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
const SUMMARY_KEYS = 3

/** A list value is decoded from a head this long — more than any line can
 *  show — with its real length kept for the "+N more" count. A cost bound:
 *  decoding the whole list would render the same. */
const MAX_DECODED_ITEMS = 100

type Decoded =
  | {kind: 'refs', ids: string[], total: number}
  | {kind: 'value', value: unknown, total?: number}

const decodeProperty = (schema: AnyPropertySchema | undefined, raw: unknown): Decoded => {
  const total = Array.isArray(raw) ? raw.length : undefined
  const head = Array.isArray(raw) && raw.length > MAX_DECODED_ITEMS ? raw.slice(0, MAX_DECODED_ITEMS) : raw
  if (!schema) return {kind: 'value', value: head, total}
  const codec = schema.codec
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

/** A value that renders as nothing; it must not spend a slot under the cap. */
const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const formatDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z')
}

const isListItem = (value: unknown): boolean => isScalar(value) || value instanceof Date

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
      if (!isListItem(item)) return `${joined}, …+${count - index} more`
      const left = count - index - 1
      const separator = index > from ? ', ' : ''
      // Room for the count of what follows, so the line's own clip never cuts it off.
      const space = budget - joined.length - separator.length - (left > 0 ? `, …+${left} more`.length : 0)
      const text = formatValue(item, budget)
      if (text.length > space && left > 0) {
        if (index > from) return `${joined}, …+${count - index} more`
        return `${text.slice(0, charBoundary(text, Math.max(1, space - 1)))}…, …+${left} more`
      }
      joined += `${separator}${text}`
    }
    return count > value.length ? `${joined}, …+${count - value.length} more` : joined
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

export const briefProperties = (lines: readonly PropertyLine[]): {shown: PropertyLine[], rest: number} => {
  const shown = lines.filter(line => !isNamespaced(line.name)).slice(0, BRIEF_PROPERTY_COUNT)
  return {shown, rest: lines.length - shown.length}
}

export interface PropertyRenderer {
  view(block: BlockData, detail: PropertyDetail): PropertyView
  /** Type labels for display (`todo`, a user type's name); an unknown
   *  user-type id is dropped rather than printed as a uuid. */
  typeLabels(block: BlockData): string[]
}

const TITLE_ROWS_SQL = `
  SELECT b.* FROM json_each(?) j JOIN blocks b ON b.id = j.value WHERE b.deleted = 0
`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bind a renderer for a batch of blocks. Per block it picks the properties
 *  it can show — visible ones, plain names first, at most
 *  {@link MAX_PROPERTIES} — and decodes only those through the registry, then
 *  loads the titles of their referenced blocks in one query, so a ref renders
 *  as `[[Title]]`. A huge bag costs its names, not its decoding (a cost
 *  bound: decoding everything would render the same). Visibility
 *  is the property panel's rule (`isPropertyPanelHiddenProperty`), so an
 *  agent sees what the user sees. */
export const createPropertyRenderer = async (
  repo: Repo,
  blocks: readonly BlockData[],
): Promise<PropertyRenderer> => {
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
  for (const block of blocks) {
    if (preparedByBlock.has(block.id)) continue
    const bag = block.properties ?? {}
    const plain: string[] = []
    const namespaced: string[] = []
    const hidden: string[] = []
    for (const name of Object.keys(bag)) {
      if (name === typesProp.name || isEmptyValue(bag[name])) continue
      if (isPropertyPanelHiddenProperty(name, schemas, overrides, definitions)) hidden.push(name)
      else (isNamespaced(name) ? namespaced : plain).push(name)
    }
    // Plain names first, so the cap can never crowd out the vocabulary the
    // brief form is built from.
    const visible = [...plain, ...namespaced]
    const shown = visible.slice(0, MAX_PROPERTIES).map(name => ({name, decoded: decodeProperty(schemas.get(name), bag[name])}))
    for (const {decoded} of shown) {
      if (decoded.kind === 'refs') decoded.ids.slice(0, MAX_REFS).forEach(id => refIds.add(id))
    }
    preparedByBlock.set(block.id, {shown, omitted: visible.length - shown.length, hidden})
  }

  const titles = new Map<string, {title: string, workspaceId: string}>()
  if (refIds.size > 0) {
    const rows = await repo.db.getAll<BlockRow>(TITLE_ROWS_SQL, [JSON.stringify([...refIds])])
    for (const row of rows) {
      const data = parseBlockRow(row)
      titles.set(data.id, {title: oneLine(labelForBlockData(data, data.id)), workspaceId: data.workspaceId})
    }
  }
  // References resolve within a workspace, so another workspace's block
  // stays a dangling ((id)) here, as it is everywhere else.
  const titleIn = (id: string, workspaceId: string): string | undefined => {
    const found = titles.get(id)
    return found?.workspaceId === workspaceId ? found.title : undefined
  }

  const display = (decoded: Decoded, block: BlockData, name: string, budget: number): string => {
    if (decoded.kind === 'refs') {
      const shown = decoded.ids.slice(0, MAX_REFS).map(id => {
        const title = titleIn(id, block.workspaceId)
        return title !== undefined ? `[[${title}]]` : `((${id}))`
      })
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
    view(block, detail) {
      const prepared = preparedByBlock.get(block.id) ?? {shown: [], omitted: 0, hidden: []}
      const maxChars = detail === 'brief' ? BRIEF_VALUE_CHARS : FULL_VALUE_CHARS
      const visible: PropertyLine[] = []
      for (const {name, decoded} of prepared.shown) {
        const value = display(decoded, block, name, maxChars)
        if (value === '') continue
        visible.push({name: clipLine(name, NAME_CHARS).text, value: clipLine(value, maxChars).text})
      }
      const hidden = prepared.hidden
      return {
        visible,
        omitted: prepared.omitted,
        hidden: boundLabels(hidden, MAX_HIDDEN_NAMES, NAME_CHARS),
      }
    },
    typeLabels(block) {
      const labels: string[] = []
      for (const typeId of readTypeIds(block)) {
        const label = repo.types.get(typeId)?.label?.trim()
        if (label) labels.push(label)
        else if (!UUID_RE.test(typeId)) labels.push(typeId)
      }
      return boundLabels([...new Set(labels)], MAX_TYPES, NAME_CHARS)
    },
  }
}

/** `key:: value` pairs for one line; the brief form is {@link briefProperties}.
 *  Everything not shown — brief's leftovers and the renderer's `omitted` — is
 *  counted. */
export const formatPropertyPairs = (
  lines: readonly PropertyLine[],
  detail: PropertyDetail,
  omitted = 0,
): string => {
  const {shown, rest} = detail === 'brief' ? briefProperties(lines) : {shown: lines, rest: 0}
  const pairs = shown.map(line => `${line.name}:: ${line.value}`)
  if (rest + omitted > 0) pairs.push(`+${rest + omitted} props`)
  return pairs.join('  ')
}
