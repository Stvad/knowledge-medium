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
  index: number,
  length: number,
): boolean => {
  const first = content[index]
  const last = content[index + length - 1]
  const before = content[index - 1]
  const after = content[index + length]
  return (!isWordChar(first) || !isWordChar(before))
    && (!isWordChar(last) || !isWordChar(after))
}

const escapeRegExp = (text: string): string =>
  text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

const caseFlags = (matchCase: boolean): string => matchCase ? 'u' : 'iu'

/** A code point outside this class has no case-insensitive partner under
 *  `caseFlags(false)`: the regex matches it only against itself. */
const HAS_CASE_PARTNER_CANDIDATE = /[\p{CWCF}\p{CWCM}]/u

let caseFoldingCodePointList: readonly string[] | undefined

/** Every code point in `HAS_CASE_PARTNER_CANDIDATE`, computed once on demand. */
export const caseFoldingCodePoints = (): readonly string[] => {
  if (caseFoldingCodePointList === undefined) {
    const found: string[] = []
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
      const char = String.fromCodePoint(codePoint)
      if (HAS_CASE_PARTNER_CANDIDATE.test(char)) found.push(char)
    }
    caseFoldingCodePointList = found
  }
  return caseFoldingCodePointList
}

/** Every code point a case-insensitive `findLiteralMatches` treats as equal
 *  to the single code point `char`, `char` itself included. */
export const caseInsensitiveVariants = (char: string): string[] => {
  if (!HAS_CASE_PARTNER_CANDIDATE.test(char)) return [char]
  const pattern = new RegExp(`^${escapeRegExp(char)}$`, caseFlags(false))
  return caseFoldingCodePoints().filter(candidate => pattern.test(candidate))
}

/** Matches are offsets into `content` itself. Case-insensitivity is the
 *  regex's per-code-point folding, never a lowercased copy of the content:
 *  lowercasing can change a string's length (`İ` becomes two code units), and
 *  offsets taken from the copy would splice a replacement into the wrong place.
 *  A whole-word rejection advances one code point, not past the candidate, so
 *  an overlapping later candidate is still considered. */
export const findLiteralMatches = (
  content: string,
  needle: string,
  options: FindReplaceOptions,
): LiteralMatch[] => {
  if (needle.length === 0) return []

  const pattern = new RegExp(escapeRegExp(needle), `g${caseFlags(options.matchCase)}`)
  const matches: LiteralMatch[] = []

  for (let found = pattern.exec(content); found; found = pattern.exec(content)) {
    const {index} = found
    const length = found[0].length
    if (!options.wholeWord || passesWholeWordBoundary(content, index, length)) {
      matches.push({index, length})
    } else {
      pattern.lastIndex = index + ((content.codePointAt(index) ?? 0) > 0xffff ? 2 : 1)
    }
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
