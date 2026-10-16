import type { Repo } from '@/data/repo'
import type { AnyPropertySchema, BlockData } from '@/data/api'
import { decodeRefId, decodeRefListIds, isRefCodec, isRefListCodec } from '@/data/api/codecs.js'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { isPropertyPanelHiddenProperty } from '@/components/propertyPanel/visibility.js'
import { labelForBlockData, readTypeIds } from '@/utils/linkTargetAutocomplete.js'
import { parseBlockRow } from '@/data/blockSchema.js'
import type { BlockRow } from '@/data/blockSchema.js'
import { clipLine, oneLine } from './text.ts'

export interface PropertyLine {
  name: string
  /** One-line display form: refs as `[[Title]]`, dates as ISO, lists joined,
   *  structured values summarized. */
  value: string
}

export interface PropertyView {
  visible: PropertyLine[]
  /** Names the property panel hides (system, UI-state, declared hidden). */
  hidden: string[]
}

export type PropertyDetail = 'brief' | 'full'

/** Shown inline on an outline line before the rest collapse to `+N props`. */
export const BRIEF_PROPERTY_COUNT = 3
const BRIEF_VALUE_CHARS = 60
const FULL_VALUE_CHARS = 300
const SUMMARY_KEYS = 3

type Decoded =
  | {kind: 'refs', ids: string[]}
  | {kind: 'value', value: unknown}

const decodeProperty = (schema: AnyPropertySchema | undefined, raw: unknown): Decoded => {
  if (!schema) return {kind: 'value', value: raw}
  const codec = schema.codec
  if (isRefCodec(codec)) {
    const id = decodeRefId(codec, raw)
    return id ? {kind: 'refs', ids: [id]} : {kind: 'value', value: raw}
  }
  if (isRefListCodec(codec)) return {kind: 'refs', ids: decodeRefListIds(codec, raw)}
  try {
    return {kind: 'value', value: codec.decode(raw)}
  } catch {
    return {kind: 'value', value: raw}
  }
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const formatDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z')
}

/** Structured values (an SRS snapshot history, an importer's payload) are
 *  summarized, never dumped — they are what made raw outlines unreadable. */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDate(value)
  if (isScalar(value)) return String(value)
  if (Array.isArray(value)) {
    if (value.every(item => isScalar(item) || item instanceof Date)) {
      return value.map(formatValue).join(', ')
    }
    return `[${value.length} items]`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    const shown = keys.slice(0, SUMMARY_KEYS).join(', ')
    return `{${shown}${keys.length > SUMMARY_KEYS ? ', …' : ''}}`
  }
  return String(value)
}

/** Order for the brief form: a plain name (`status`, `interval`) is the shared
 *  vocabulary of the graph; a `namespace:`-prefixed one is usually one
 *  plugin's or importer's bookkeeping (`matrix-event:id`, `roam:create/time`),
 *  so it yields the inline slots first. Stable within each group. */
const briefOrder = (a: PropertyLine, b: PropertyLine): number =>
  Number(a.name.includes(':')) - Number(b.name.includes(':'))

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

/** Bind a renderer for a batch of blocks: decodes every property through the
 *  registry once, then loads the titles of all referenced blocks in one
 *  query so a ref renders as `[[Title]]` instead of an id. Visibility is the
 *  property panel's rule (`isPropertyPanelHiddenProperty`), so an agent sees
 *  what the user sees. */
export const createPropertyRenderer = async (
  repo: Repo,
  blocks: readonly BlockData[],
): Promise<PropertyRenderer> => {
  const schemas = repo.propertySchemas
  const overrides = repo.propertyEditorOverrides
  const definitions = repo.propertyDefinitions

  const decodedByBlock = new Map<string, Array<{name: string, hidden: boolean, decoded: Decoded}>>()
  const refIds = new Set<string>()
  for (const block of blocks) {
    if (decodedByBlock.has(block.id)) continue
    const entries: Array<{name: string, hidden: boolean, decoded: Decoded}> = []
    for (const [name, raw] of Object.entries(block.properties ?? {})) {
      if (name === typesProp.name) continue
      const hidden = isPropertyPanelHiddenProperty(name, schemas, overrides, definitions)
      const decoded = decodeProperty(schemas.get(name), raw)
      if (!hidden && decoded.kind === 'refs') decoded.ids.forEach(id => refIds.add(id))
      entries.push({name, hidden, decoded})
    }
    decodedByBlock.set(block.id, entries)
  }

  const titles = new Map<string, string>()
  if (refIds.size > 0) {
    const rows = await repo.db.getAll<BlockRow>(TITLE_ROWS_SQL, [JSON.stringify([...refIds])])
    for (const row of rows) {
      const data = parseBlockRow(row)
      titles.set(data.id, oneLine(labelForBlockData(data, data.id)))
    }
  }

  const display = (decoded: Decoded, block: BlockData, name: string): string => {
    if (decoded.kind === 'refs') {
      return decoded.ids.map(id => titles.has(id) ? `[[${titles.get(id)}]]` : `((${id}))`).join(', ')
    }
    // A page's first alias is its title, already on the line.
    if (name === aliasesProp.name && Array.isArray(decoded.value)) {
      const content = block.content.trim()
      return formatValue(decoded.value.filter(alias => alias !== content))
    }
    return formatValue(decoded.value)
  }

  return {
    view(block, detail) {
      const visible: PropertyLine[] = []
      const hidden: string[] = []
      const maxChars = detail === 'brief' ? BRIEF_VALUE_CHARS : FULL_VALUE_CHARS
      for (const {name, hidden: isHidden, decoded} of decodedByBlock.get(block.id) ?? []) {
        if (isHidden) {
          hidden.push(name)
          continue
        }
        const value = display(decoded, block, name)
        if (value === '') continue
        visible.push({name, value: clipLine(value, maxChars).text})
      }
      if (detail === 'brief') visible.sort(briefOrder)
      return {visible, hidden}
    },
    typeLabels(block) {
      const labels: string[] = []
      for (const typeId of readTypeIds(block)) {
        const label = repo.types.get(typeId)?.label?.trim()
        if (label) labels.push(label)
        else if (!UUID_RE.test(typeId)) labels.push(typeId)
      }
      return [...new Set(labels)]
    },
  }
}

/** `key:: value` pairs for one line; the brief form keeps the first
 *  {@link BRIEF_PROPERTY_COUNT} and counts the rest. */
export const formatPropertyPairs = (
  lines: readonly PropertyLine[],
  detail: PropertyDetail,
): string => {
  const shown = detail === 'brief' ? lines.slice(0, BRIEF_PROPERTY_COUNT) : lines
  const pairs = shown.map(line => `${line.name}:: ${line.value}`)
  const rest = lines.length - shown.length
  if (rest > 0) pairs.push(`+${rest} props`)
  return pairs.join('  ')
}
