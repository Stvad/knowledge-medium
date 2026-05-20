import type { ContentSearchMatch, FindReplaceOptions } from './types.ts'

export const DEFAULT_FIND_REPLACE_OPTIONS: FindReplaceOptions = {
  matchCase: false,
  wholeWord: false,
}

interface LiteralMatch {
  index: number
  length: number
}

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_]/.test(char)

const passesWholeWordBoundary = (
  content: string,
  needle: string,
  index: number,
): boolean => {
  const first = needle[0]
  const last = needle[needle.length - 1]
  const before = content[index - 1]
  const after = content[index + needle.length]
  return (!isWordChar(first) || !isWordChar(before))
    && (!isWordChar(last) || !isWordChar(after))
}

export const findLiteralMatches = (
  content: string,
  needle: string,
  options: FindReplaceOptions,
): LiteralMatch[] => {
  if (needle.length === 0) return []

  const haystack = options.matchCase ? content : content.toLocaleLowerCase()
  const target = options.matchCase ? needle : needle.toLocaleLowerCase()
  const matches: LiteralMatch[] = []
  let start = 0

  for (;;) {
    const index = haystack.indexOf(target, start)
    if (index < 0) break
    if (!options.wholeWord || passesWholeWordBoundary(content, needle, index)) {
      matches.push({index, length: needle.length})
    }
    start = index + needle.length
  }

  return matches
}

export const replaceLiteralMatches = (
  content: string,
  find: string,
  replace: string,
  options: FindReplaceOptions,
): {content: string; replacementCount: number} => {
  const matches = findLiteralMatches(content, find, options)
  if (matches.length === 0) {
    return {content, replacementCount: 0}
  }

  let cursor = 0
  let next = ''
  for (const match of matches) {
    next += content.slice(cursor, match.index)
    next += replace
    cursor = match.index + match.length
  }
  next += content.slice(cursor)

  return {content: next, replacementCount: matches.length}
}

const compactWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim()

export const previewForMatch = (
  content: string,
  match: LiteralMatch,
  contextChars = 48,
): string => {
  const start = Math.max(0, match.index - contextChars)
  const end = Math.min(content.length, match.index + match.length + contextChars)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < content.length ? '...' : ''
  return `${prefix}${compactWhitespace(content.slice(start, end))}${suffix}`
}

export const buildContentSearchMatch = (
  blockId: string,
  content: string,
  query: string,
  options: FindReplaceOptions,
): ContentSearchMatch | null => {
  const matches = findLiteralMatches(content, query, options)
  const first = matches[0]
  if (first === undefined) return null
  return {
    blockId,
    originalContent: content,
    matchCount: matches.length,
    preview: previewForMatch(content, first),
  }
}
