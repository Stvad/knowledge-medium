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

  let out = raw

  // 1. Embeds (must run before bare block refs)
  out = out.replace(EMBED_RE, (_, roamUid: string) => `!((${resolve(roamUid)}))`)

  // 2. Aliased block refs `[label](((uid)))`
  out = out.replace(
    ALIASED_BLOCK_REF_RE,
    (_, label: string, roamUid: string) => `[${label}] ((${resolve(roamUid)}))`,
  )

  // 3. Bare block refs `((uid))`
  out = out.replace(BLOCK_REF_RE, (_, roamUid: string) => `((${resolve(roamUid)}))`)

  // 4. `#[[multi word]]` → `[[multi word]]`
  out = out.replace(HASH_PAGE_RE, (_, lead: string, label: string) => `${lead}[[${label}]]`)

  // 5. `#word` → `[[word]]` (URL-safe by lookbehind)
  out = out.replace(HASH_TAG_RE, (_, lead: string, label: string) => `${lead}[[${label}]]`)

  return {content: out, unresolvedBlockUids: [...unresolved]}
}

export const applyHeading = (content: string, heading: number | undefined): string => {
  if (!heading || heading <= 0) return content
  const safe = Math.min(heading, 6)
  const prefix = '#'.repeat(safe) + ' '
  return `${prefix}${content}`
}
