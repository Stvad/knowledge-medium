export type ExactReferenceBlockContent =
  | {kind: 'alias'; alias: string}
  | {kind: 'blockRef'; id: string}

// Exact reference blocks are allowed to target any concrete block id.
// Keep this broader grammar scoped to whole-block content; the inline
// references plugin intentionally stays UUID-only so prose like
// "((not a ref))" does not become a backlink.
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID_RE_SOURCE}$`, 'i')
const EXACT_BLOCK_REF_RE = /^\(\(([^()\s]+)\)\)$/

export const parseExactReferenceBlockContent = (
  content: string,
): ExactReferenceBlockContent | null => {
  const trimmed = content.trim()
  const blockRef = EXACT_BLOCK_REF_RE.exec(trimmed)
  if (blockRef) {
    const id = blockRef[1]
    return {kind: 'blockRef', id: UUID_RE.test(id) ? id.toLowerCase() : id}
  }

  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return null
  const alias = trimmed.slice(2, -2).trim()
  if (!alias || alias.includes('[[') || alias.includes(']]')) return null
  return {kind: 'alias', alias}
}

export const referenceBlockContentForLabel = (label: string): string =>
  `[[${label.replace(/]]/g, '] ]')}]]`
