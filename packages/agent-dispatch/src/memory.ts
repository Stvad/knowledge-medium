/*
 * A watcher's memory: one block per note under a `Memory` block that is a
 * direct child of the watched page, plus the shared notes its outline shows:
 * the blocks its embeds (`!((id))`, `![[Page]]`) bring in, which other
 * watchers' memories can embed too. The run keeps it with the ordinary km
 * write tools; the daemon reports what changed in both, so a write to it is
 * never silent. An embed past the outline's bounds is not a shared note.
 */

/** The content that marks the memory block among the watched page's children. */
export const MEMORY_BLOCK_TITLE = 'Memory'

export interface MemoryEntry {
  id: string
  content: string
}

export interface MemoryDiff {
  saved: MemoryEntry[]
  edited: MemoryEntry[]
  removed: MemoryEntry[]
}

export const diffMemory = (before: MemoryEntry[], after: MemoryEntry[]): MemoryDiff => {
  const beforeById = new Map(before.map(entry => [entry.id, entry.content]))
  const afterIds = new Set(after.map(entry => entry.id))
  return {
    saved: after.filter(entry => !beforeById.has(entry.id)),
    edited: after.filter(entry => beforeById.has(entry.id) && beforeById.get(entry.id) !== entry.content),
    removed: before.filter(entry => !afterIds.has(entry.id)),
  }
}

const PREVIEW_CHARS = 60

/** A reference reads as words rather than as a bare id: an embed as an embed
 *  (of the page it names), an aliased link as its label, a plain ref as one. */
const REFERENCE_WORDS: Array<[RegExp, string]> = [
  [/!\(\([^()\s]+\)\)/g, 'embedded block'],
  [/!\[\[([^[\]]+)\]\]/g, 'embedded $1'],
  [/\[([^[\]]*)\]\(\(\([^()\s]+\)\)\)/g, '$1'],
  [/\(\([^()\s]+\)\)/g, 'block ref'],
]

/** One line of plain text: brackets, parens and `#` go, so a preview can
 *  never form a page link, block ref or tag in the reply. */
const preview = (content: string): string => {
  const words = REFERENCE_WORDS.reduce((text, [pattern, word]) => text.replace(pattern, word), content)
  const flat = words.replace(/[[\]()#]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

/** The reply's account of a run's memory writes; null when there were none.
 *  "During this run" because a concurrent run of the same watcher writes the
 *  same block. */
export const renderMemoryChanges = (diff: MemoryDiff): string | null => {
  const link = (entry: MemoryEntry) => `[${preview(entry.content) || 'entry'}](((${entry.id})))`
  const parts = [
    ...(diff.saved.length ? [`saved ${diff.saved.map(link).join(', ')}`] : []),
    ...(diff.edited.length ? [`edited ${diff.edited.map(link).join(', ')}`] : []),
    // A removed block can't be linked; its id is what restore_block takes.
    ...(diff.removed.length ? [`removed ${diff.removed.map(entry => `"${preview(entry.content)}" (\`${entry.id}\`)`).join(', ')}`] : []),
  ]
  return parts.length ? `Memory changed during this run: ${parts.join('; ')}` : null
}
