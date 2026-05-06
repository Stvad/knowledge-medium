// Content rewrites for Roam-style markdown → our markdown.
//
// What this does:
//   - `((roamUid))`            → `((<our-uuid>))`        (block ref)
//   - `{{embed: ((roamUid))}}` / `{{[[embed]]: ((roamUid))}}`
//                              → `!((<our-uuid>))`       (block embed,
//                                                        Obsidian-style)
//   - `[label](((roamUid)))`   → `[label](((<our-uuid>)))`
//   - `#[[multi word]]`        → `[[multi word]]`
//   - `#word`                  → `[[word]]`              (only when not
//                                                        inside a URL or
//                                                        identifier)
//   - heading prepends `'#'.repeat(level) + ' '`
//
// Block uids that aren't in the map are left literal so we can spot
// dangling refs in the import diagnostics. Page references (`[[Page]]`)
// pass through unchanged — our existing alias-resolution pipeline handles
// them at write time.

const ROAM_UID = '[A-Za-z0-9_-]+'

// `{{embed: ((uid))}}` / `{{[[embed]]: ((uid))}}` — match BEFORE the bare
// `((uid))` so we don't double-replace.
const ROAM_EMBED_DIRECTIVE = '(?:embed|\\[\\[embed\\]\\])'
const EMBED_RE = new RegExp(`\\{\\{\\s*${ROAM_EMBED_DIRECTIVE}\\s*:\\s*\\(\\((${ROAM_UID})\\)\\)\\s*\\}\\}`, 'g')

// `[label](((uid)))` — Roam's aliased block ref. Markdown link with a
// `((uid))` href.
const ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]]+)\\]\\(\\(\\((${ROAM_UID})\\)\\)\\)`, 'g')

// Bare `((uid))`. Run after the two more-specific rewrites consume their
// surrounding syntax.
const BLOCK_REF_RE = new RegExp(`\\(\\((${ROAM_UID})\\)\\)`, 'g')

// `#[[anything]]` and `#word` (word being [\w/-]+, allowing namespacey
// tags like `#wcs/concept`). The leading guard prevents mid-identifier
// hashes from matching; protected ranges below handle page refs, code,
// and URLs.
const HASH_PAGE_RE = /(^|[^\w/:])#\[\[([^\]]+)\]\]/g
const HASH_TAG_RE = /(^|[^\w/:])#([\w/-]+)/g
const URL_RE = /https?:\/\/[^\s<>)\]]+/g

export interface ContentRewriteResult {
  content: string
  unresolvedBlockUids: string[]
}

// Surface every Roam uid the content uses as a `((uid))` block-ref or
// `{{embed: ((uid))}}` / `{{[[embed]]: ((uid))}}` embed. Used by the
// planner to register a
// deterministic id for refs whose target isn't a block elsewhere in the
// export — so the orchestrator can mint an empty placeholder block,
// `((uid))` in content gets rewritten to the placeholder uuid, and a
// later import that brings in the real block upserts onto that row.
export const collectContentRefUids = (content: string): string[] => {
  const out = new Set<string>()
  const matchAllAt = (re: RegExp, captureIndex: number) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) out.add(m[captureIndex])
  }
  matchAllAt(EMBED_RE, 1)
  // ALIASED_BLOCK_REF_RE: [label](((uid))) — group 1 is label, group 2 is uid.
  matchAllAt(ALIASED_BLOCK_REF_RE, 2)
  matchAllAt(BLOCK_REF_RE, 1)
  return [...out]
}

interface BlockRefMatch {
  start: number
  end: number
  replacement: string
}

// Resolve all `((uid))` / `{{embed: ((uid))}}` /
// `{{[[embed]]: ((uid))}}` / `[label](((uid)))`
// occurrences against the *source* string in a single pass, so the
// resolved-UUID output of one rewrite isn't fed back into the next
// rewrite (which would treat it as a fresh uid to look up). Returns
// the rewrites as positioned slices the caller can stitch.
const collectBlockRefRewrites = (
  raw: string,
  resolve: (roamUid: string) => string,
): BlockRefMatch[] => {
  const found: BlockRefMatch[] = []
  const consumed: Array<[number, number]> = []

  const overlapsConsumed = (start: number, end: number) =>
    consumed.some(([s, e]) => start < e && end > s)

  const collect = (re: RegExp, makeMatch: (m: RegExpExecArray) => BlockRefMatch) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const match = makeMatch(m)
      if (overlapsConsumed(match.start, match.end)) continue
      found.push(match)
      consumed.push([match.start, match.end])
    }
  }

  // Embeds first — the most-specific shape wins so the inner `((uid))`
  // isn't double-counted.
  collect(EMBED_RE, m => ({
    start: m.index,
    end: m.index + m[0].length,
    replacement: `!((${resolve(m[1])}))`,
  }))
  collect(ALIASED_BLOCK_REF_RE, m => ({
    start: m.index,
    end: m.index + m[0].length,
    replacement: `[${m[1]}](((${resolve(m[2])})))`,
  }))
  collect(BLOCK_REF_RE, m => ({
    start: m.index,
    end: m.index + m[0].length,
    replacement: `((${resolve(m[1])}))`,
  }))

  return found.sort((a, b) => a.start - b.start)
}

interface ProtectedRange {
  start: number
  end: number
}

const rangeContains = (range: ProtectedRange, index: number): boolean =>
  index >= range.start && index < range.end

const rangeOverlaps = (range: ProtectedRange, start: number, end: number): boolean =>
  start < range.end && end > range.start

const isProtected = (
  ranges: ReadonlyArray<ProtectedRange>,
  start: number,
  end: number,
): boolean =>
  ranges.some(range => rangeContains(range, start) || rangeOverlaps(range, start, end))

const findClosingParen = (value: string, start: number): number => {
  let depth = 1
  for (let i = start; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

const collectMarkdownLinkDestinationRanges = (content: string): ProtectedRange[] => {
  const ranges: ProtectedRange[] = []
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] !== ']' || content[i + 1] !== '(') continue
    const destinationStart = i + 2
    const destinationEnd = findClosingParen(content, destinationStart)
    if (destinationEnd < 0) continue
    ranges.push({start: destinationStart, end: destinationEnd})
    i = destinationEnd
  }
  return ranges
}

const collectCodeRanges = (content: string): ProtectedRange[] => {
  const ranges: ProtectedRange[] = []
  let i = 0
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3)
      const rangeEnd = end < 0 ? content.length : end + 3
      ranges.push({start: i, end: rangeEnd})
      i = rangeEnd
      continue
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1)
      if (end < 0) break
      ranges.push({start: i, end: end + 1})
      i = end + 1
      continue
    }
    i += 1
  }
  return ranges
}

const collectPageRefRanges = (content: string): ProtectedRange[] => {
  const ranges: ProtectedRange[] = []
  const stack: number[] = []
  let i = 0
  while (i < content.length - 1) {
    const token = content.slice(i, i + 2)
    if (token === '[[') {
      // Roam hash-page syntax (`#[[tag]]`) is intentionally rewritten,
      // so do not protect that page-ref-shaped fragment.
      if (content[i - 1] !== '#') stack.push(i)
      i += 2
      continue
    }
    if (token === ']]') {
      if (stack.length > 0) {
        const start = stack.pop()!
        if (stack.length === 0) ranges.push({start, end: i + 2})
      }
      i += 2
      continue
    }
    i += 1
  }
  return ranges
}

const collectUrlRanges = (content: string): ProtectedRange[] => {
  const ranges: ProtectedRange[] = []
  URL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_RE.exec(content)) !== null) {
    ranges.push({start: match.index, end: match.index + match[0].length})
  }
  return ranges
}

const collectHashRewriteProtectedRanges = (content: string): ProtectedRange[] =>
  [
    ...collectCodeRanges(content),
    ...collectMarkdownLinkDestinationRanges(content),
    ...collectPageRefRanges(content),
    ...collectUrlRanges(content),
  ].sort((a, b) => a.start - b.start || a.end - b.end)

const rewriteHashPages = (
  content: string,
  protectedRanges: ReadonlyArray<ProtectedRange>,
): string =>
  content.replace(HASH_PAGE_RE, (match, lead: string, label: string, offset: number) => {
    const hashStart = offset + lead.length
    return isProtected(protectedRanges, hashStart, offset + match.length)
      ? match
      : `${lead}[[${label}]]`
  })

const rewriteHashTags = (
  content: string,
  protectedRanges: ReadonlyArray<ProtectedRange>,
): string =>
  content.replace(HASH_TAG_RE, (match, lead: string, label: string, offset: number) => {
    const hashStart = offset + lead.length
    return isProtected(protectedRanges, hashStart, offset + match.length)
      ? match
      : `${lead}[[${label}]]`
  })

export const rewriteRoamContent = (
  raw: string,
  uidMap: ReadonlyMap<string, string>,
): ContentRewriteResult => {
  const unresolved = new Set<string>()

  const resolve = (roamUid: string): string => {
    const ourId = uidMap.get(roamUid)
    if (ourId) return ourId
    unresolved.add(roamUid)
    return roamUid
  }

  // Stitch the block-ref rewrites in one pass over the source so each
  // `((uid))` is resolved exactly once.
  const rewrites = collectBlockRefRewrites(raw, resolve)
  let out = ''
  let cursor = 0
  for (const r of rewrites) {
    out += raw.slice(cursor, r.start) + r.replacement
    cursor = r.end
  }
  out += raw.slice(cursor)

  // Hash-tag rewrites operate on the post-block-ref string, but must not
  // touch syntax that merely contains a hash: existing page refs like
  // `[[Promotion #L6]]`, URLs, or code snippets.
  const protectedRanges = collectHashRewriteProtectedRanges(out)
  out = rewriteHashPages(out, protectedRanges)
  out = rewriteHashTags(out, protectedRanges)

  return {content: out, unresolvedBlockUids: [...unresolved]}
}

export const applyHeading = (content: string, heading: number | undefined): string => {
  if (!heading || heading <= 0) return content
  const safe = Math.min(heading, 6)
  const prefix = '#'.repeat(safe) + ' '
  return `${prefix}${content}`
}
