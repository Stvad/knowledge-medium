/**
 * Turn an undo entry into the words a receipt shows.
 *
 * The entry's snapshots are the uniform source: per block, `before` and
 * `after`. `entry.description` is free-form and usually absent, so it is
 * never shown raw — the receipt derives everything from what the rows say.
 *
 * Pure over `UndoEntry`, so the phrasing is plain vitest.
 */
import type { BlockData } from '@/data/api'
import type { UndoEntry } from '@/data/internals/undoManager'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'

export type ChangeKind = 'content' | 'properties' | 'delete' | 'move' | 'create'

/** Kinds in the order a receipt names them: the row the user acted on
 *  beats the rows a helper touched alongside it. A reschedule creates a
 *  daily note and writes one property — the property row is the subject;
 *  a move into a collapsed destination also flips the destination's
 *  collapse flag — the moved row is the subject. */
const SUBJECT_PRIORITY: readonly ChangeKind[] = ['content', 'move', 'delete', 'properties', 'create']

/** Kinds that carry rows along: a deleted subtree's children, a pasted
 *  root's descendants. A property or content change on a parent carries
 *  nothing. */
const STRUCTURAL: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['create', 'delete', 'move'])

export interface RowChange {
  id: string
  kind: ChangeKind
  before: BlockData | null
  after: BlockData | null
}

/** A content change, split into the shared prefix / suffix and the two
 *  differing middles, so the toast can render "prefix ~~gone~~ now suffix"
 *  in either direction. Windowed around the change: long shared text is
 *  clipped with an ellipsis. */
export interface ContentPeek {
  prefix: string
  suffix: string
  /** The differing middle of `before` / `after`. Which one the gesture
   *  removed depends on its direction — see {@link phrase}. */
  beforeSegment: string
  afterSegment: string
}

export interface EntrySummary {
  /** The row the receipt names — the topmost changed block (its parent is
   *  not itself structurally changed in the entry) of the highest-priority
   *  kind — or null when the entry touched only property field rows. */
  subject: {
    id: string
    workspaceId: string
    label: string
    /** True when `label` is the block's content rather than an alias — a
     *  content peek then already shows it. */
    labelIsContent: boolean
    kind: ChangeKind
    parentBefore: string | null
    parentAfter: string | null
  } | null
  /** Changed rows under the subject: the children a delete or a paste took
   *  along. Rows the entry touched elsewhere are not counted. */
  others: number
  /** Present when the subject's content changed. */
  peek: ContentPeek | null
  /** Property names that changed on the subject, when its kind is
   *  `properties`. */
  changedProperties: string[]
}

const changedPropertyNames = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null))

/** What one row's snapshot pair says happened to it. A row a tx touched
 *  without changing anything the user can see is dropped. */
export const classifyRow = (id: string, before: BlockData | null, after: BlockData | null): RowChange | null => {
  if (before === null && after === null) return null
  if (before === null || (before.deleted && after !== null && !after.deleted)) {
    return {id, kind: 'create', before, after}
  }
  if (after === null || (!before.deleted && after.deleted)) {
    return {id, kind: 'delete', before, after}
  }
  if (before.parentId !== after.parentId || before.orderKey !== after.orderKey) {
    return {id, kind: 'move', before, after}
  }
  if (before.content !== after.content) return {id, kind: 'content', before, after}
  if (changedPropertyNames(before.properties, after.properties).length > 0) {
    return {id, kind: 'properties', before, after}
  }
  return null
}

const PEEK_CONTEXT = 24
const PEEK_SEGMENT = 48

const clipEnd = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)
const clipStart = (s: string, max: number): string => (s.length > max ? `…${s.slice(-max)}` : s)

/** Split two texts into shared prefix, shared suffix and differing middles.
 *  Whole-word-agnostic on purpose: the point is to show WHICH characters a
 *  gesture changed, and a word boundary would hide a one-letter fix. */
export const contentPeek = (before: string, after: string): ContentPeek => {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start += 1
  let end = 0
  while (
    end < max - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end += 1
  return {
    prefix: clipStart(before.slice(0, start), PEEK_CONTEXT),
    suffix: clipEnd(before.slice(before.length - end), PEEK_CONTEXT),
    beforeSegment: clipEnd(before.slice(start, before.length - end), PEEK_SEGMENT),
    afterSegment: clipEnd(after.slice(start, after.length - end), PEEK_SEGMENT),
  }
}

const isFieldRow = (row: RowChange): boolean =>
  (row.after ?? row.before)?.isFieldForm === true

/** The row's parent in whichever state has one; a moved row's two parents
 *  both count. */
const parentsOf = (row: RowChange): string[] =>
  [row.before?.parentId, row.after?.parentId].filter((p): p is string => typeof p === 'string')

/** Rows whose parent the entry ALSO changed structurally are riders — the
 *  children of a deleted subtree, the blocks under a pasted root. The
 *  receipt names the row at the top. */
const isTopmost = (row: RowChange, structuralIds: ReadonlySet<string>): boolean =>
  !parentsOf(row).some(parent => structuralIds.has(parent))

/** Rows under `subjectId`, walking parents within the entry only. */
const countUnder = (subjectId: string, rows: readonly RowChange[]): number => {
  const parentById = new Map(rows.map(row => [row.id, parentsOf(row)] as const))
  const under = new Set<string>([subjectId])
  // Rows may come in any order; iterate until the set stops growing.
  let grew = true
  while (grew) {
    grew = false
    for (const [id, parents] of parentById) {
      if (!under.has(id) && parents.some(parent => under.has(parent))) {
        under.add(id)
        grew = true
      }
    }
  }
  return under.size - 1
}

export const summarizeEntry = (entry: UndoEntry): EntrySummary => {
  const rows: RowChange[] = []
  for (const [id, snap] of entry.snapshots) {
    const row = classifyRow(id, snap.before, snap.after)
    if (row !== null) rows.push(row)
  }
  const visible = rows.filter(row => !isFieldRow(row))
  const structuralIds = new Set(visible.filter(row => STRUCTURAL.has(row.kind)).map(row => row.id))
  const topmost = visible.filter(row => isTopmost(row, structuralIds))
  const pool = topmost.length > 0 ? topmost : visible
  let subjectRow: RowChange | null = null
  for (const kind of SUBJECT_PRIORITY) {
    subjectRow = pool.find(row => row.kind === kind) ?? null
    if (subjectRow !== null) break
  }
  if (subjectRow === null) {
    return {subject: null, others: 0, peek: null, changedProperties: []}
  }
  const data = (subjectRow.after ?? subjectRow.before)!
  const before = subjectRow.before
  const after = subjectRow.after
  const labelSource = (subjectRow.kind === 'delete' ? before : data)!
  const label = labelForBlockData(labelSource, 'Untitled')
  return {
    subject: {
      id: subjectRow.id,
      workspaceId: data.workspaceId,
      label,
      labelIsContent: label === labelSource.content.trim(),
      kind: subjectRow.kind,
      parentBefore: before?.parentId ?? null,
      parentAfter: after?.parentId ?? null,
    },
    others: countUnder(subjectRow.id, visible),
    peek: subjectRow.kind === 'content' && before !== null && after !== null
      ? contentPeek(before.content, after.content)
      : null,
    changedProperties: subjectRow.kind === 'properties' && before !== null && after !== null
      ? changedPropertyNames(before.properties, after.properties)
      : [],
  }
}

/** Which way a gesture ran over the entry. `undo` restores `before`;
 *  `forward` (a fresh action) and `redo` land on `after`. */
export type Direction = 'undo' | 'redo' | 'forward'

export interface Phrase {
  /** "Undid edit", "Restored", "Deleted" — the gesture, from the user's
   *  side of the screen. */
  verb: string
  /** "and 7 children" — the rows the subject brought along. */
  riders: string
  /** The content delta as the gesture left it: `gone` is what the
   *  gesture took out of the text, `now` what it put in. */
  peek: {prefix: string; gone: string; now: string; suffix: string} | null
}

/** `agenda:scheduled` → "scheduled"; `weave:cover_img` → "cover img". */
export const propertyDisplayName = (name: string): string =>
  name.slice(name.lastIndexOf(':') + 1).replace(/[_-]+/g, ' ')

const VERBS: Record<Direction, Record<ChangeKind, string>> = {
  undo: {content: 'Undid edit', properties: 'Undid change', delete: 'Restored', move: 'Moved back', create: 'Removed'},
  redo: {content: 'Redid edit', properties: 'Redid change', delete: 'Deleted again', move: 'Moved again', create: 'Restored'},
  forward: {content: 'Edited', properties: 'Changed', delete: 'Deleted', move: 'Moved', create: 'Created'},
}

const RIDER_NOUN: Record<ChangeKind, string> = {
  delete: 'children',
  create: 'more',
  content: 'more',
  properties: 'more',
  move: 'more',
}

export const phrase = (summary: EntrySummary, direction: Direction): Phrase => {
  const subject = summary.subject
  if (subject === null) return {verb: VERBS[direction].properties, riders: '', peek: null}
  let verb = VERBS[direction][subject.kind]
  if (subject.kind === 'properties' && summary.changedProperties.length === 1) {
    const prop = propertyDisplayName(summary.changedProperties[0])
    verb = direction === 'undo' ? `Undid ${prop} change` : direction === 'redo' ? `Redid ${prop} change` : `Changed ${prop}`
  }
  const riders = summary.others > 0 ? `and ${summary.others} ${RIDER_NOUN[subject.kind]}` : ''
  const peek = summary.peek === null ? null : {
    prefix: summary.peek.prefix,
    suffix: summary.peek.suffix,
    gone: direction === 'undo' ? summary.peek.afterSegment : summary.peek.beforeSegment,
    now: direction === 'undo' ? summary.peek.beforeSegment : summary.peek.afterSegment,
  }
  return {verb, riders, peek}
}
