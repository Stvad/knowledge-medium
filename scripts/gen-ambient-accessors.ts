// Regenerate the `generatedEntries` section of
// eslint-rules/ambientAccessors.data.js from `@ambient` JSDoc tags on
// exported declarations in src/. Mirrors scripts/gen-sync-config.ts's
// generate/--check structure: default mode writes the file, `--check`
// mode diffs in memory and fails without writing (wired into
// `pnpm check` as `check:ambient-accessors`, same as `check:sync-config`).
//
// Run via `pnpm gen:ambient-accessors` after tagging a new export, or
// `pnpm check:ambient-accessors` (no writes) to fail CI on a stale table
// or a hand-edit inside the generated span.
//
// --- @ambient tag grammar ---------------------------------------------
//
// Tag an EXPORTED `const`/`function` declaration's JSDoc with two tags:
//
//   /**
//    * ...normal doc prose...
//    *
//    * @ambient allowIn: <repo-relative-path>[, <repo-relative-path>...]
//    * @ambientMessage <free-text lint error, one line>
//    */
//   export const someAccessor = () => ...
//
// - `@ambient`'s value is `allowIn:` followed by a comma-separated list of
//   repo-relative file paths (matched by suffix, same as the table's
//   `allowIn` arrays elsewhere) — the only files allowed to import this
//   export directly.
// - `@ambientMessage` is a SEPARATE tag, not part of `@ambient`'s own
//   text: JSDoc tags are conventionally one logical line each, and the
//   restriction message is usually a full sentence with punctuation, so
//   keeping it out of `@ambient` avoids fighting comment line-wrapping.
//   Required whenever `@ambient` is present.
// - The generator turns the tagged export into one
//   `{kind:'import', module, names, message, allowIn}` entry: `module` is
//   the `@/`-style specifier for the file (`src/data/repoProvider.ts` →
//   `@/data/repoProvider`), `names` is the exported identifier. Tagged
//   exports in the same file that end up with an identical
//   module/message/allowIn triple are merged into one entry with multiple
//   `names`, so the table stays compact.
//
// This is deliberately the WHOLE mechanism for making a new restriction
// "a one-tag affair": e.g. the un-merged getLayoutSessionId follow-up
// (PR #425) just needs the same two tags added to its export — no
// eslint.config.js edit, no new eslint-rules module. (It's not applied on
// this branch: 9 call sites haven't migrated to the injected channel yet
// and would fail lint immediately.)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export interface GeneratedEntry {
  readonly kind: 'import'
  readonly module: string
  readonly names: string[]
  readonly message: string
  readonly allowIn: string[]
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
export const SRC_DIR = resolve(ROOT, 'src')
const TABLE_PATH = resolve(ROOT, 'eslint-rules', 'ambientAccessors.data.js')

const BEGIN_MARKER =
  '// --- BEGIN GENERATED ambientAccessors (do not edit; run `pnpm run gen:ambient-accessors`) ---'
const END_MARKER = '// --- END GENERATED ambientAccessors ---'

// --- src/ walk ---------------------------------------------------------

const SOURCE_EXT_RE = /\.tsx?$/

const walkSourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walkSourceFiles(full, out)
    } else if (SOURCE_EXT_RE.test(name)) {
      out.push(full)
    }
  }
  return out
}

// --- @ambient tag extraction --------------------------------------------

interface TaggedExport {
  readonly file: string
  readonly names: string[]
  readonly allowIn: string[]
  readonly message: string
}

export const parseAllowIn = (text: string): string[] =>
  text
    .replace(/^allowIn:\s*/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const exportedNames = (statement: ts.Statement): string[] => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((decl) => (ts.isIdentifier(decl.name) ? decl.name.text : undefined))
      .filter((name): name is string => Boolean(name))
  }
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return [statement.name.text]
  }
  return []
}

const isExported = (statement: ts.Statement): boolean =>
  Boolean(ts.canHaveModifiers(statement)
    && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

/** src/data/repoProvider.ts -> @/data/repoProvider */
export const toModuleSpecifier = (file: string): string => {
  const rel = relative(SRC_DIR, file).replaceAll('\\', '/').replace(SOURCE_EXT_RE, '')
  return `@/${rel}`
}

const extractTaggedExports = (file: string): TaggedExport[] => {
  const text = readFileSync(file, 'utf-8')
  if (!text.includes('@ambient')) return []

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: TaggedExport[] = []

  for (const statement of sourceFile.statements) {
    const tags = ts.getJSDocTags(statement)
    const ambientTag = tags.find((t) => t.tagName.text === 'ambient')
    if (!ambientTag) continue

    if (!isExported(statement)) {
      throw new Error(`${file}: @ambient tag on a non-exported declaration — tag the export site.`)
    }

    const names = exportedNames(statement)
    if (names.length === 0) {
      throw new Error(`${file}: @ambient tag on an unsupported declaration (only exported const/function are supported).`)
    }

    const allowInText = ts.getTextOfJSDocComment(ambientTag.comment) ?? ''
    const allowIn = parseAllowIn(allowInText)
    if (allowIn.length === 0) {
      throw new Error(`${file}: @ambient tag on ${names.join(', ')} is missing "allowIn: <path>[, <path>...]".`)
    }

    const messageTag = tags.find((t) => t.tagName.text === 'ambientMessage')
    const message = messageTag ? ts.getTextOfJSDocComment(messageTag.comment)?.trim() : undefined
    if (!message) {
      throw new Error(`${file}: @ambient tag on ${names.join(', ')} has no companion @ambientMessage.`)
    }

    found.push({ file, names, allowIn, message })
  }

  return found
}

const collectGeneratedEntries = (): GeneratedEntry[] => {
  const merged = new Map<string, GeneratedEntry>()

  for (const file of walkSourceFiles(SRC_DIR)) {
    for (const tagged of extractTaggedExports(file)) {
      const module = toModuleSpecifier(tagged.file)
      const key = JSON.stringify([module, tagged.message, [...tagged.allowIn].sort()])
      const existing = merged.get(key)
      if (existing) {
        for (const name of tagged.names) {
          if (!existing.names.includes(name)) existing.names.push(name)
        }
        continue
      }
      merged.set(key, {
        kind: 'import',
        module,
        names: [...tagged.names],
        message: tagged.message,
        allowIn: [...tagged.allowIn],
      })
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.module === b.module ? a.message.localeCompare(b.message) : a.module.localeCompare(b.module))
}

// --- render --------------------------------------------------------------

export const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export const renderEntry = (entry: GeneratedEntry): string => {
  const lines = [
    '  {',
    `    kind: 'import',`,
    `    module: ${quote(entry.module)},`,
    `    names: [${entry.names.map(quote).join(', ')}],`,
    `    message: ${quote(entry.message)},`,
  ]
  if (entry.allowIn.length === 1) {
    lines.push(`    allowIn: [${quote(entry.allowIn[0])}],`)
  } else {
    lines.push('    allowIn: [')
    for (const path of entry.allowIn) lines.push(`      ${quote(path)},`)
    lines.push('    ],')
  }
  lines.push('  },')
  return lines.join('\n')
}

export const renderGeneratedSpan = (entries: GeneratedEntry[]): string => {
  const body = entries.map(renderEntry).join('\n')
  return [
    BEGIN_MARKER,
    'export const generatedEntries = [',
    body,
    ']',
    END_MARKER,
  ].join('\n')
}

export const replaceGeneratedSpan = (tableText: string, span: string): string => {
  const beginIdx = tableText.indexOf(BEGIN_MARKER)
  const endIdx = tableText.indexOf(END_MARKER)
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `${TABLE_PATH}: missing BEGIN/END generated markers — file was hand-edited past recovery, restore them.`,
    )
  }
  return tableText.slice(0, beginIdx) + span + tableText.slice(endIdx + END_MARKER.length)
}

// --- main ------------------------------------------------------------------

// Skip the side-effecting src/ walk + write when this file is imported by
// vitest (which sets VITEST=true in its workers) — the unit tests only
// exercise the named exports above. Same guard as check-rpc-projections.ts.
if (!process.env.VITEST) {
  const entries = collectGeneratedEntries()
  const existing = existsSync(TABLE_PATH) ? readFileSync(TABLE_PATH, 'utf-8') : ''
  const generated = replaceGeneratedSpan(existing, renderGeneratedSpan(entries))

  const isCheck = process.argv.includes('--check')
  const rel = relative(process.cwd(), TABLE_PATH)

  if (isCheck) {
    if (existing !== generated) {
      console.error(`❌ ${rel} is stale. Run \`pnpm gen:ambient-accessors\` and commit the result.`)
      process.exit(1)
    }
    console.log(`✓ ${rel} is up to date.`)
  } else {
    writeFileSync(TABLE_PATH, generated)
    console.log(`Wrote ${rel} (${entries.length} generated entr${entries.length === 1 ? 'y' : 'ies'}).`)
  }
}
