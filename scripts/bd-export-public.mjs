#!/usr/bin/env node
/**
 * Write `.beads/issues.jsonl` with attribution stripped.
 *
 * That file is tracked on a PUBLIC repo (see docs/cloud-sessions.md for why it
 * is tracked at all), and `bd export` stamps `owner` / `created_by` /
 * `updated_by` / `assignee` onto every record it has them for — real names and
 * email addresses, committed permanently into git history. Nothing downstream
 * needs them: `bd import` upserts only the fields a record carries, so an
 * import of a scrubbed file leaves the receiving database's own attribution
 * intact (verified — importing a record with `owner` removed did not clear it).
 *
 * Comments are dropped, which is a correctness requirement rather than a
 * privacy one: `bd import` INSERTS comments instead of upserting them, so a
 * file carrying a comment the receiving database already has aborts the whole
 * import ("duplicate primary key given"), not just that record. Measured — a
 * full export re-imported into its own database fails on the first commented
 * issue, and the same file with `comments` removed imports all 211 cleanly.
 * Losing comment text is the lesser cost; `bd backup` carries everything when
 * that matters.
 *
 * Memories are excluded by `bd export`'s default and must stay excluded: they
 * sync only to the private Dolt remote. Never add --all / --include-memories.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Any key whose value is a person. Applied at EVERY depth, not just the top
// level: comments carry their own `author`, which a top-level-only pass misses
// while reporting success.
const IDENTITY_FIELDS = new Set([
  'owner', 'created_by', 'updated_by', 'assignee', 'author', 'actor', 'reporter',
])
const OUT = '.beads/issues.jsonl'

let stripped = 0

let commentsDropped = 0

const scrub = (value, top = false) => {
  if (Array.isArray(value)) return value.map(v => scrub(v))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (IDENTITY_FIELDS.has(key) && nested !== null && nested !== undefined) {
      stripped++
      continue
    }
    if (top && key === 'comments' && Array.isArray(nested) && nested.length > 0) {
      commentsDropped += nested.length
      continue
    }
    out[key] = scrub(nested)
  }
  return out
}

const raw = execFileSync('bd', ['export'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  env: {...process.env, BD_IGNORE_SCHEMA_SKEW: '1'},
})

const lines = raw.split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.stringify(scrub(JSON.parse(line), true)))

writeFileSync(OUT, lines.join('\n') + '\n')
console.log(
  `wrote ${OUT}: ${lines.length} issues, ${stripped} attribution field(s) stripped, ` +
  `${commentsDropped} comment(s) dropped`,
)
