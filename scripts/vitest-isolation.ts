import { globSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// A module evaluated under one file's mock stays cached with the mock bound in,
// and invalidating a mocked module gives the next file a second copy of it while
// its cached dependents hold the first (two `createContext` instances, say).
const REWRITES_MODULE_GRAPH = /\bvi\.(?:mock|doMock|unmock|doUnmock|resetModules)\(/
// What a DOM test leaves on its window (listeners, patched prototypes, portals,
// the selection) cannot be enumerated, so no reset between files could undo it.
const NON_NODE_ENVIRONMENT = /@(?:vitest|jest)-environment\s+(?!node\b)/

// Files no rule catches, each with why it cannot share a worker.
export const ISOLATED_FILES: Readonly<Record<string, string>> = {
  'scripts/agent-eval/fixtureGraph.test.ts': 'nodeShims installs localStorage, window and document, which later node files must not inherit',
}

export const needsOwnWorker = (source: string): boolean =>
  REWRITES_MODULE_GRAPH.test(source) || NON_NODE_ENVIRONMENT.test(source)

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.claude', '.codex', 'tmp'])

export const listIsolatedTestFiles = (pattern: string, root: string): string[] => {
  const files = globSync(pattern, {cwd: root, exclude: dirent => SKIPPED_DIRECTORIES.has(dirent.name), withFileTypes: true})
  const byRule = files
    .map(file => relative(root, join(file.parentPath, file.name)))
    .filter(path => needsOwnWorker(readFileSync(join(root, path), 'utf8')))
  return [...Object.keys(ISOLATED_FILES), ...byRule]
}
