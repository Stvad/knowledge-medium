export type ExactReferenceBlockContent =
  | {kind: 'alias'; alias: string}
  | {kind: 'blockRef'; id: string}

const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const EXACT_BLOCK_REF_RE = new RegExp(`^\\(\\((${UUID_RE_SOURCE})\\)\\)$`, 'i')

export const parseExactReferenceBlockContent = (
  content: string,
): ExactReferenceBlockContent | null => {
  const trimmed = content.trim()
  const blockRef = EXACT_BLOCK_REF_RE.exec(trimmed)
  if (blockRef) return {kind: 'blockRef', id: blockRef[1].toLowerCase()}

  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return null
  const alias = trimmed.slice(2, -2).trim()
  if (!alias || alias.includes('[[') || alias.includes(']]')) return null
  return {kind: 'alias', alias}
}

export const referenceBlockContentForLabel = (label: string): string =>
  `[[${label.replace(/]]/g, '] ]')}]]`
