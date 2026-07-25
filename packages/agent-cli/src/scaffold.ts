/**
 * `kmagent new-extension` — the starting shape for a repo extension.
 *
 * Templates teach more reliably than docs do, because they get copied
 * verbatim. So this scaffold is not an empty skeleton: it is a small,
 * working extension written the way the `record-grain` guide asks for —
 * namespaced types, a ref property instead of an id string, one block per
 * record via `createTypedChild`, a pure read path with a real test, and
 * done-ness composed from the built-in todo. What an author changes first
 * is the domain; the shape comes along for free.
 *
 * The output is a STANDALONE project: its own dependencies, its own gate,
 * and the `@/…` kernel declarations copied in from this package (the same
 * ones `kmagent types` writes). Most people reaching for this have the
 * published CLI and no checkout of the app, so the scaffold must not assume
 * one — nothing here resolves through a repo root.
 */

export interface ScaffoldFile {
  /** Path relative to the extension directory. */
  path: string
  contents: string
}

/** `Reading List` → `reading-list`. */
export const slugify = (name: string): string =>
  name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

/** `reading-list` → `READING_LIST`, for generated constant names. */
const constantPrefix = (slug: string): string => slug.replace(/-/g, '_').toUpperCase()

/** `reading-list` → `Reading List` (display name + bundle file name). */
export const titleize = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

const packageJson = (slug: string): string => `${JSON.stringify({
  name: `${slug}-extension`,
  private: true,
  type: 'module',
  scripts: {
    typecheck: 'tsc -p tsconfig.json --noEmit',
    test: 'vitest run --config vitest.config.ts',
    build: 'vite build --config vite.config.ts',
    check: 'npm run typecheck && npm run test && npm run build',
    // The `@/…` declarations are generated, not authored — refresh them
    // after upgrading the CLI (they track the app version it ships with).
    types: 'kmagent types ./types --force',
  },
  devDependencies: {
    '@types/node': '^25.0.0',
    '@types/react': '^19.2.15',
    '@types/react-dom': '^19.2.3',
    '@vitejs/plugin-react': '^6.0.1',
    react: '^19.2.6',
    'react-dom': '^19.2.6',
    typescript: '^6.0.3',
    vite: '^8.0.10',
    vitest: '^4.1.5',
  },
}, null, 2)}\n`

const tsconfig = (): string => `${JSON.stringify({
  compilerOptions: {
    allowImportingTsExtensions: true,
    baseUrl: '.',
    ignoreDeprecations: '6.0',
    jsx: 'react-jsx',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    noEmit: true,
    // `@/…` is whatever the app provides at runtime; these declarations are
    // the app's own, copied in by the scaffold (refresh: npm run types).
    paths: {'@/*': ['./types/src/*']},
    skipLibCheck: true,
    strict: true,
    target: 'ES2022',
    // `node` covers the vite/vitest config files; react types are here so a
    // renderer can be added without touching this config.
    types: ['node', 'react', 'react-dom'],
  },
  include: ['src/**/*', 'test/**/*', 'vite.config.ts', 'vitest.config.ts'],
}, null, 2)}\n`

const viteConfig = (title: string): string => `import react from '@vitejs/plugin-react'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'

const configDir = dirname(fileURLToPath(import.meta.url))

// Everything the app provides at runtime stays external: React, and every
// \`@/…\` module. The bundle is just this extension's own code.
const isExternal = (id: string): boolean =>
  id === 'react' || id.startsWith('react/') ||
  id === 'react-dom' || id.startsWith('react-dom/') ||
  id.startsWith('@/')

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(configDir, 'src/index.ts'),
      formats: ['es'],
      fileName: () => '${title}.js',
    },
    rollupOptions: {external: isExternal, output: {codeSplitting: false}},
  },
})
`

const vitestConfig = (): string => `import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // Only needed if a test imports a module that touches the app's
    // runtime modules; the pure read path deliberately doesn't.
    alias: {'@': resolve(configDir, 'types/src')},
  },
})
`

const fields = (slug: string, ns: string): string => `/** Type ids and property names as plain constants.
 *
 *  Free of any \`@/\` import on purpose: the pure read path imports these,
 *  which is what lets the block → record mapping be unit-tested in plain
 *  node while \`schema.ts\` pulls in the real seeding machinery.
 *
 *  Everything is namespaced. Type ids and property names share ONE global
 *  namespace across every plugin and extension in the workspace — a bare
 *  \`entry\` or \`status\` collides, and the loser silently gets the other
 *  schema's codec.
 */

export const ENTRY_TYPE = '${slug}-entry'
export const COLLECTION_TYPE = '${slug}-collection'

export const FIELD = {
  /** Ref to the collection this entry belongs to. A REF, not an id string:
   *  it projects into a real reference, so the collection's backlinks are
   *  its entries, and the link survives renaming or moving the target. */
  collection: '${ns}:collection',
  /** Scalar facts about the entry. */
  rating: '${ns}:rating',
  notedAt: '${ns}:notedAt',
  /** Done-ness is the built-in todo's own (un-namespaced) property — this
   *  extension composes with \`todo\` rather than declaring its own flag. */
  todoStatus: 'status',
} as const
`

const schema = (ns: string, title: string): string => `/** Block schema: what this extension stores, declared once.
 *
 *  The shape follows the \`record-grain\` guide — read it with
 *  \`pnpm agent describe-runtime --guide record-grain\`:
 *   - one block per record, never a list of records in a JSON property
 *   - pointers are ref-typed properties, never bare id strings
 *   - compose built-in types instead of re-declaring their fields
 */

import {ChangeScope, seedProperty, seedType} from '@/data/api/index.js'
import {
  extensionPropertySeedKey,
  extensionTypeSeedKey,
} from '@/extensions/dynamicExtensionSeeds.js'

import {COLLECTION_TYPE, ENTRY_TYPE, FIELD} from './fields'

export {COLLECTION_TYPE, ENTRY_TYPE, FIELD} from './fields'

/** The collection an entry belongs to. \`optional-ref\` (not a string) is
 *  what makes the collection's backlinks list its entries. */
export const collectionProp = seedProperty({
  seedKey: extensionPropertySeedKey('collection'),
  revision: 1,
  name: FIELD.collection,
  preset: 'optional-ref',
  config: {targetTypes: [COLLECTION_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const ratingProp = seedProperty({
  seedKey: extensionPropertySeedKey('rating'),
  revision: 1,
  name: FIELD.rating,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const notedAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('noted-at'),
  revision: 1,
  name: FIELD.notedAt,
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const collectionType = seedType({
  seedKey: extensionTypeSeedKey('collection'),
  revision: 1,
  id: COLLECTION_TYPE,
  label: '${title} collection',
  description: 'Groups entries; its backlinks are the entries that point at it.',
})

export const entryType = seedType({
  seedKey: extensionTypeSeedKey('entry'),
  revision: 1,
  id: ENTRY_TYPE,
  label: '${title} entry',
  description: 'One record. A block, so it can be queried, linked, undone, and hand-edited.',
  properties: [collectionProp, ratingProp, notedAtProp],
})

export const ${constantPrefix(ns)}_PROPS = [collectionProp, ratingProp, notedAtProp]
export const ${constantPrefix(ns)}_TYPES = [collectionType, entryType]
`

const store = (ns: string): string => `/** The write path.
 *
 *  One block per record, created with \`createTypedChild\` — create,
 *  type-tag and typed properties in one call inside a transaction, so a
 *  batch lands and undoes atomically.
 */

import {ChangeScope, propertyValue} from '@/data/api/index.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild} from '@/data/typedRecords.js'
import {TODO_TYPE, statusProp as todoStatusProp} from '@/plugins/todo/schema.js'

import {ENTRY_TYPE} from './fields'
import {collectionProp, notedAtProp, ratingProp} from './schema'

export interface EntryDraft {
  title: string
  rating?: number
  done?: boolean
}

/** Add entries under \`collectionId\`. Each becomes its own block: typed,
 *  linked back to the collection, and ALSO a todo — so it renders as a
 *  checkbox and answers todo queries, instead of carrying a private done
 *  flag nothing else understands. */
export const addEntries = async (
  repo: Repo,
  collectionId: string,
  drafts: readonly EntryDraft[],
  now: Date = new Date(),
): Promise<string[]> => {
  const ids: string[] = []
  await repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    for (const draft of drafts) {
      ids.push(await createTypedChild(repo, tx, {
        parentId: collectionId,
        // Readable on its own: the record still makes sense in the outline
        // after this extension is uninstalled.
        content: draft.title,
        types: [ENTRY_TYPE, TODO_TYPE],
        properties: [
          propertyValue(collectionProp, collectionId),
          propertyValue(notedAtProp, now),
          propertyValue(todoStatusProp, draft.done ? 'done' : 'open'),
          ...(draft.rating !== undefined ? [propertyValue(ratingProp, draft.rating)] : []),
        ],
        typeSnapshot,
      }))
    }
  }, {scope: ChangeScope.BlockDefault, description: 'Add ${ns} entries'})
  return ids
}
`

const read = (): string => `/** The read path: rows → records.
 *
 *  Pure, and importing only field NAMES (no \`@/\` module), so the mapping
 *  is unit-testable in plain node. Property values arrive codec-encoded —
 *  dates as ISO strings, everything else identity JSON.
 */

import {FIELD} from './fields'

/** The subset of a block row these readers need — a structural subset of
 *  the app's \`BlockData\`, so real rows satisfy it without the import. */
export interface RowLike {
  id: string
  parentId: string | null
  orderKey: string
  properties: Record<string, unknown>
}

export interface EntryRecord {
  id: string
  title: string
  collectionId?: string
  rating?: number
  done: boolean
}

const optNum = (row: RowLike, name: string): number | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'number' ? raw : undefined
}

const optStr = (row: RowLike, name: string): string | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

const compareByOrderKey = (a: RowLike, b: RowLike): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

export const buildEntries = (
  rows: readonly RowLike[],
  contentOf: (row: RowLike) => string,
): EntryRecord[] =>
  rows
    .slice()
    .sort(compareByOrderKey)
    .map(row => ({
      id: row.id,
      title: contentOf(row),
      collectionId: optStr(row, FIELD.collection),
      rating: optNum(row, FIELD.rating),
      // Done-ness composes with the built-in todo, so it reads the todo's
      // own status rather than a private flag.
      done: row.properties[FIELD.todoStatus] === 'done',
    }))
`

const index = (slug: string, title: string, ns: string): string => `/** ${title} — wiring only.
 *
 *  Everything with logic lives in a module that can be tested without the
 *  app: \`read.ts\` is pure, \`store.ts\` is the write path, \`schema.ts\` is
 *  the declaration. This file just contributes them.
 */

import {actionsFacet} from '@/extensions/core.js'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'

import {${constantPrefix(ns)}_PROPS, ${constantPrefix(ns)}_TYPES} from './schema'

const source = '${slug}'

const helloAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: '${ns}.hello',
  description: '${title}: say hello',
  context: ActionContextTypes.GLOBAL,
  handler: async () => {
    console.log('[${slug}] replace me with something useful')
  },
}

export default [
  ...${constantPrefix(ns)}_PROPS.map(prop => definitionSeedsFacet.of(prop, {source})),
  ...${constantPrefix(ns)}_TYPES.map(type => typeSeedsFacet.of(type, {source})),
  actionsFacet.of(helloAction, {source}),
]
`

const readTest = (): string => `import {describe, expect, it} from 'vitest'

import {buildEntries, type RowLike} from '../src/read'
import {FIELD} from '../src/fields'

const row = (id: string, orderKey: string, properties: Record<string, unknown>): RowLike =>
  ({id, parentId: 'collection-1', orderKey, properties})

describe('buildEntries', () => {
  it('reads entries in outline order, with done-ness from the composed todo', () => {
    const entries = buildEntries(
      [
        row('b', 'a1', {[FIELD.collection]: 'collection-1', [FIELD.todoStatus]: 'open'}),
        row('a', 'a0', {[FIELD.collection]: 'collection-1', [FIELD.rating]: 5, [FIELD.todoStatus]: 'done'}),
      ],
      r => \`entry \${r.id}\`,
    )

    expect(entries.map(e => e.id)).toEqual(['a', 'b'])
    expect(entries[0]).toMatchObject({rating: 5, done: true, collectionId: 'collection-1'})
    expect(entries[1].done).toBe(false)
  })

  it('tolerates a row missing every optional property', () => {
    const [entry] = buildEntries([row('a', 'a0', {})], () => 'untitled')
    expect(entry).toMatchObject({id: 'a', title: 'untitled', done: false})
    expect(entry.rating).toBeUndefined()
  })
})
`

const readme = (title: string): string => `# ${title}

A Knowledge Medium extension: code stored in a block, loaded by the app at
runtime. Generated by \`kmagent new-extension\`; the data model follows the
\`record-grain\` guide.

## Getting it running

\`\`\`sh
npm install
npm run check                                   # typecheck + test + build
kmagent install-extension "dist/${title}.js"    # reports whether it RUNS
kmagent enable-extension "${title}"             # first install needs this
\`\`\`

\`install-extension\` prints \`running: true\` once the app is actually
executing the code. Until then nothing it declares (types, properties,
renderers) is registered, and writes that depend on those schemas land raw.

Editing it later is the same two steps — install re-pins the approval for
you, since this device already trusted the extension.

## The shape

- \`src/fields.ts\` — type ids + property names, no \`@/\` imports, so the
  read path is testable in plain node.
- \`src/schema.ts\` — seeded types and properties. Namespaced; pointers are
  ref-typed; records are blocks.
- \`src/store.ts\` — writes, one block per record via \`createTypedChild\`,
  composing the built-in \`todo\` for done-ness.
- \`src/read.ts\` — pure rows → records.
- \`src/index.ts\` — wiring only.

## Checking your data model

\`\`\`sh
kmagent data-model                              # blocks, refs, backlinks
kmagent describe-runtime --guide record-grain   # what becomes a block
kmagent audit-extension "${title}"              # grain check on real data
\`\`\`

\`audit-extension\` reads the blocks you actually wrote: block ids parked in
non-ref properties, records buried in JSON cells, properties with no
registered schema.

## \`types/\`

\`@/…\` modules are provided by the app at runtime; \`types/\` holds their
declarations so your editor and \`tsc\` can see them. They ship with the CLI
— refresh after upgrading it:

\`\`\`sh
npm run types
\`\`\`
`

const gitignore = (): string => `node_modules/
dist/
types/
`

/** Every file of a new extension, ready to write. */
export const extensionScaffold = (rawName: string): ScaffoldFile[] => {
  const slug = slugify(rawName)
  if (!slug) throw new Error('new-extension: name must contain at least one letter or digit')
  const title = titleize(slug)
  // Property names are GLOBAL, so the namespace has to identify the whole
  // extension: `reading-list` and `reading-notes` both prefixing `reading:`
  // would collide on every shared field name, and the loser silently gets
  // the other's codec — the exact failure the scaffold's own doctrine warns
  // about. Constants derive from the same slug with a legal identifier.
  const ns = slug

  return [
    {path: 'package.json', contents: packageJson(slug)},
    {path: 'tsconfig.json', contents: tsconfig()},
    {path: 'vite.config.ts', contents: viteConfig(title)},
    {path: 'vitest.config.ts', contents: vitestConfig()},
    {path: 'src/fields.ts', contents: fields(slug, ns)},
    {path: 'src/schema.ts', contents: schema(ns, title)},
    {path: 'src/store.ts', contents: store(ns)},
    {path: 'src/read.ts', contents: read()},
    {path: 'src/index.ts', contents: index(slug, title, ns)},
    {path: 'test/read.test.ts', contents: readTest()},
    {path: 'README.md', contents: readme(title)},
    {path: '.gitignore', contents: gitignore()},
  ]
}
