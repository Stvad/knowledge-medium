// Content rewrites for Roam-style markdown → our markdown.
//
// What this does:
//   - `((roamUid))`            → `((<our-uuid>))`        (block ref)
//   - `{{embed: ((roamUid))}}` → `!((<our-uuid>))`       (block embed,
//                                                        Obsidian-style)
//   - `[label](((roamUid)))`   → `[label] ((<our-uuid>))`
//                                (preserves the alias text + a working
//                                ref; we don't have aliased-block-ref
//                                syntax yet)
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

// `{{embed: ((uid))}}` — match BEFORE the bare `((uid))` so we don't
// double-replace.
const EMBED_RE = new RegExp(`\\{\\{\\s*embed\\s*:\\s*\\(\\((${ROAM_UID})\\)\\)\\s*\\}\\}`, 'g')

// `[label](((uid)))` — Roam's aliased block ref. Markdown link with a
// `((uid))` href.
const ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]]+)\\]\\(\\(\\((${ROAM_UID})\\)\\)\\)`, 'g')

// Bare `((uid))`. Run after the two more-specific rewrites consume their
// surrounding syntax.
const BLOCK_REF_RE = new RegExp(`\\(\\((${ROAM_UID})\\)\\)`, 'g')

// `#[[anything]]` and `#word` (word being [\w/-]+, allowing namespacey
// tags like `#wcs/concept`). The leading lookbehind guard prevents URL
// fragment ids and mid-identifier hashes from matching.
const HASH_PAGE_RE = /(^|[^\w/:])#\[\[([^\]]+)\]\]/g
const HASH_TAG_RE = /(^|[^\w/:])#([\w/-]+)/g

export interface ContentRewriteResult {
  content: string
  unresolvedBlockUids: string[]
}

// Surface every Roam uid the content uses as a `((uid))` block-ref or
// `{{embed: ((uid))}}` embed. Used by the planner to register a
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

// Resolve all `((uid))` / `{{embed: ((uid))}}` / `[label](((uid)))`
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
    replacement: `[${m[1]}] ((${resolve(m[2])}))`,
  }))
  collect(BLOCK_REF_RE, m => ({
    start: m.index,
    end: m.index + m[0].length,
    replacement: `((${resolve(m[1])}))`,
  }))

  return found.sort((a, b) => a.start - b.start)
}

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

  // Tag rewrites operate on the post-block-ref string. They don't share
  // syntax with the block-ref forms, so plain sequential replace is safe.
  out = out.replace(HASH_PAGE_RE, (_, lead: string, label: string) => `${lead}[[${label}]]`)
  out = out.replace(HASH_TAG_RE, (_, lead: string, label: string) => `${lead}[[${label}]]`)

  return {content: out, unresolvedBlockUids: [...unresolved]}
}

export const applyHeading = (content: string, heading: number | undefined): string => {
  if (!heading || heading <= 0) return content
  const safe = Math.min(heading, 6)
  const prefix = '#'.repeat(safe) + ' '
  return `${prefix}${content}`
}
