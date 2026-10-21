#!/usr/bin/env node
/**
 * Write `.beads/issues.jsonl` for the PUBLIC repo. Why not a bare `bd export`
 * (see docs/cloud-sessions.md for why the file is tracked at all):
 *
 * - ATTRIBUTION must go. `bd export` stamps real names and emails onto
 *   `owner`/`created_by`/`updated_by`/`assignee` and onto every comment's
 *   `author`; committing them publishes them permanently. Nothing downstream
 *   needs them — `bd import` upserts only the fields a record carries, so the
 *   receiving database keeps its own.
 * - COMMENTS must go. `bd import` INSERTs them rather than upserting, so a
 *   comment the receiving database already has aborts the WHOLE import, not
 *   just that record. Losing comment text is the lesser cost; `bd backup`
 *   carries everything when that matters.
 * - MEMORIES must stay out: they sync only to the private Dolt remote, and
 *   `bd export` omits them by default. Never add --all / --include-memories.
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
