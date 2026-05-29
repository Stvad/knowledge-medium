// Validate that "@projects: <table> [+ <extra>, ...]" tags in SQL and TS
// match the source-of-truth column lists in workspaceSchema.ts /
// blockSchema.ts. Catches the drift shape that the E2EE design-doc review
// repeatedly surfaced: a column added to a workspace-related Postgres table
// didn't propagate to a RETURNS TABLE projection or a TS row interface.
// See docs/schema-generator-extension.md.
//
// Tag formats (the marker is the same in both languages, only the comment
// prefix differs):
//
//   SQL (above CREATE OR REPLACE FUNCTION ... RETURNS TABLE(...))
//     -- @projects: workspace_members + email
//
//   TS (above interface NAME { ... } or type NAME = { ... })
//     // @projects: workspace_invitations + workspace_name
//
// "+ <extra>, ..." declares fields the projection adds beyond the base
// table (typically JOIN columns). Trailing "?" in an extra is allowed and
// stripped — optional fields on the TS side still count as projected.
//
// Run via `yarn check:rpc-projections`. Wired into `yarn check`.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema'
import {
  WORKSPACE_COLUMNS,
  WORKSPACE_INVITATION_COLUMNS,
  WORKSPACE_MEMBER_COLUMNS,
} from '@/data/workspaceSchema'

const TABLE_SOT: Record<string, readonly string[]> = {
  workspaces: WORKSPACE_COLUMNS.map((c) => c.name),
  workspace_members: WORKSPACE_MEMBER_COLUMNS.map((c) => c.name),
  workspace_invitations: [...WORKSPACE_INVITATION_COLUMNS],
  blocks: BLOCK_STORAGE_COLUMNS.map((c) => c.name),
}

interface ParsedTag {
  readonly table: string
  readonly extras: readonly string[]
}

/** Parse `@projects: <table> [+ <extra1>, <extra2>?, ...]`. */
export const parseTag = (text: string): ParsedTag | null => {
  const m = text.match(/@projects:\s*([a-z_][a-z0-9_]*)(?:\s*\+\s*([^\r\n]+))?/)
  if (!m) return null
  const extrasRaw = m[2]?.trim() ?? ''
  const extras = extrasRaw
    ? extrasRaw
        .split(',')
        .map((s) => s.trim().replace(/\?$/, ''))
        .filter(Boolean)
    : []
  return { table: m[1], extras }
}

/** Walk forward from `openIdx` and return the index of the closing bracket
 *  that matches the opening bracket at `openIdx`. -1 if unbalanced. */
const matchBracket = (
  text: string,
  openIdx: number,
  open: string,
  close: string,
): number => {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split `inside` on commas at depth 0 (ignoring commas nested in parens). */
const splitTopLevelCommas = (inside: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(inside.slice(start, i))
      start = i + 1
    }
  }
  out.push(inside.slice(start))
  return out
}

/** Extract column names from the `RETURNS TABLE(...)` clause that follows
 *  `searchFrom` in `sql`. Columns look like `"id" "text"` or `id text`. */
export const extractReturnsTableColumns = (
  sql: string,
  searchFrom: number,
): string[] | null => {
  const tableIdx = sql.indexOf('RETURNS TABLE', searchFrom)
  if (tableIdx < 0) return null
  const openIdx = sql.indexOf('(', tableIdx)
  if (openIdx < 0) return null
  const closeIdx = matchBracket(sql, openIdx, '(', ')')
  if (closeIdx < 0) return null
  const inside = sql.slice(openIdx + 1, closeIdx)
  return splitTopLevelCommas(inside)
    .map((part) => {
      const m = part.trim().match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?/)
      return m ? m[1] : ''
    })
    .filter(Boolean)
}

/** Extract top-level field names from the TS object body whose `{` is at
 *  `openBraceIdx`. Skips comments / blank lines. Tolerates optional `?:`. */
export const extractTsFields = (
  text: string,
  openBraceIdx: number,
): string[] | null => {
  const closeIdx = matchBracket(text, openBraceIdx, '{', '}')
  if (closeIdx < 0) return null
  const body = text.slice(openBraceIdx + 1, closeIdx)
  // Walk lines; the row types in this codebase are flat (string / number /
  // Uint8Array). If a richer shape ever appears, this picks the top-level
  // identifier and skips its nested body — which is fine for drift checks.
  const fields: string[] = []
  let depth = 0
  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed && !trimmed.startsWith('//') && depth === 0) {
      const m = trimmed.match(/^(\w+)\??\s*:/)
      if (m) fields.push(m[1])
    }
    // Track brace depth across lines in case a field type is a nested
    // object literal spanning multiple lines.
    for (const c of rawLine) {
      if (c === '{') depth++
      else if (c === '}') depth--
    }
  }
  return fields
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly tag: string
  readonly table: string
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  readonly note?: string
}

const findLineNumber = (text: string, charIndex: number): number =>
  text.slice(0, charIndex).split('\n').length

const buildExpected = (
  table: string,
  extras: readonly string[],
): Set<string> | null => {
  const base = TABLE_SOT[table]
  if (!base) return null
  return new Set([...base, ...extras])
}

const diff = (
  expected: Set<string>,
  actual: readonly string[],
): { missing: string[]; unexpected: string[] } => {
  const actualSet = new Set(actual)
  return {
    missing: [...expected].filter((c) => !actualSet.has(c)),
    unexpected: actual.filter((c) => !expected.has(c)),
  }
}

type Extractor = (text: string, tagIndex: number) => string[] | null

const SQL_TAG_RE = /--\s*@projects:[^\r\n]+/g
const TS_TAG_RE = /\/\/\s*@projects:[^\r\n]+/g

const checkFile = (
  file: string,
  text: string,
  tagRe: RegExp,
  extract: Extractor,
  language: 'sql' | 'ts',
): Finding[] => {
  const findings: Finding[] = []
  for (const match of text.matchAll(tagRe)) {
    const tagIndex = match.index ?? 0
    const tagText = match[0]
    const parsed = parseTag(tagText)
    const line = findLineNumber(text, tagIndex)
    if (!parsed) {
      findings.push({
        file,
        line,
        tag: tagText,
        table: '?',
        missing: [],
        unexpected: [],
        note: 'tag could not be parsed (expected "@projects: <table> [+ <extra>...]")',
      })
      continue
    }
    const expected = buildExpected(parsed.table, parsed.extras)
    if (!expected) {
      findings.push({
        file,
        line,
        tag: tagText,
        table: parsed.table,
        missing: [],
        unexpected: [],
        note: `unknown table "${parsed.table}" — add it to TABLE_SOT in this script`,
      })
      continue
    }
    const actual = extract(text, tagIndex)
    if (!actual) {
      findings.push({
        file,
        line,
        tag: tagText,
        table: parsed.table,
        missing: [],
        unexpected: [],
        note:
          language === 'sql'
            ? 'no RETURNS TABLE(...) found after tag'
            : 'no { ... } block found after tag',
      })
      continue
    }
    const d = diff(expected, actual)
    if (d.missing.length || d.unexpected.length) {
      findings.push({
        file,
        line,
        tag: tagText,
        table: parsed.table,
        missing: d.missing,
        unexpected: d.unexpected,
      })
    }
  }
  return findings
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const SQL_DIR = resolve(ROOT, 'supabase', 'migrations')
const TS_FILES = [
  resolve(ROOT, 'src', 'data', 'workspaceSchema.ts'),
  resolve(ROOT, 'src', 'data', 'workspaces.ts'),
]

const findings: Finding[] = []

if (existsSync(SQL_DIR)) {
  for (const name of readdirSync(SQL_DIR)) {
    if (!name.endsWith('.sql')) continue
    const path = resolve(SQL_DIR, name)
    const text = readFileSync(path, 'utf-8')
    findings.push(...checkFile(path, text, SQL_TAG_RE, extractReturnsTableColumns, 'sql'))
  }
}

for (const path of TS_FILES) {
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf-8')
  findings.push(
    ...checkFile(
      path,
      text,
      TS_TAG_RE,
      (t, idx) => {
        const open = t.indexOf('{', idx)
        return open < 0 ? null : extractTsFields(t, open)
      },
      'ts',
    ),
  )
}

if (findings.length === 0) {
  console.log('✓ All @projects: tags match their column sources of truth.')
  process.exit(0)
}

for (const f of findings) {
  const rel = relative(process.cwd(), f.file)
  console.error(`❌ ${rel}:${f.line}  ${f.tag.trim()}`)
  if (f.note) console.error(`   ${f.note}`)
  if (f.missing.length) {
    console.error(`   missing from projection: ${f.missing.join(', ')}`)
  }
  if (f.unexpected.length) {
    console.error(`   unexpected in projection: ${f.unexpected.join(', ')}`)
  }
}
console.error('')
console.error('A column added to a workspace-related table must propagate to every')
console.error('tagged RETURNS TABLE clause and TS row interface. See')
console.error('docs/schema-generator-extension.md for the propagation chain.')
process.exit(1)
