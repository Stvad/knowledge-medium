/**
 * Transitive-closure walk over the emitted ESM module graph, used by
 * `inject-sw-build-id.mjs` to precache lazy chunks that must stay
 * offline-available.
 *
 * Why this exists: `@babel/standalone` (~0.85 MB gz) is dynamically
 * imported by `compileExtensionModule` only when an extension's source
 * needs (re)compiling. Removing its static import (#167) took it out of
 * the first-paint HTML graph — and therefore out of the service worker's
 * precache set — so a COLD offline compile (first boot after upgrade, or
 * editing an extension before Babel was ever fetched) would fail. Adding
 * the chunk back to the precache restores offline parity while keeping
 * #167's actual win: Babel is still out of the eager `modulepreload` set
 * and is never parsed/evaluated on boot, only fetched-from-cache + parsed
 * when a compile actually runs.
 *
 * A lazy chunk can import sibling chunks (e.g. Babel pulls in the shared
 * `_virtual/_rolldown/runtime.js`), so precaching just the entry file
 * isn't enough — we follow its static relative imports transitively.
 *
 * Pure + dependency-injected (`exists` / `readFile` over dist-relative
 * POSIX paths) so it unit-tests without touching the real filesystem.
 */
import {posix} from 'node:path'

// Match the bundler-emitted static imports/exports that pull in a sibling
// chunk. Two shapes: `import/export ... from './x'` and the bare
// side-effect `import './x'`. Both are anchored to a line start and only
// capture RELATIVE specifiers (`./` or `../`), which is what keeps a
// `from "..."` sitting inside a module's body (Babel ships codegen
// templates full of them) from being mistaken for a real graph edge.
// The clause between `import`/`export` and `from` MAY span newlines (a
// multi-line `import {\n a,\n b\n} from './x'`) — we still exclude
// quotes/backticks/`;`, so a `from "..."` inside a string literal can't be
// crossed into. `assertClosureComplete` (below) is the backstop for any
// edge these miss.
const FROM_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["'](\.[^"']*)["']/g
const BARE_IMPORT = /(?:^|\n)\s*import\s*["'](\.[^"']*)["']/g

const relativeImports = (source) => {
  const specs = new Set()
  for (const re of [FROM_IMPORT, BARE_IMPORT]) {
    for (const match of source.matchAll(re)) specs.add(match[1])
  }
  return [...specs]
}

// Broad relative-specifier matcher used ONLY to VERIFY the precise walk
// above didn't drop an edge. Deliberately permissive — it also catches
// dynamic `import("./x")`, which the static walk never follows — because a
// precached chunk that imports a NON-precached chunk would 404 offline, and
// we want that to be a loud build failure rather than a silent break. It is
// safe to be loose: a match only matters when it RESOLVES to one of our
// emitted chunks, so a relative path sitting in a code string (which won't
// resolve to a chunk) can't cause a spurious failure.
const VERIFY_REL_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g

/**
 * Backstop for {@link transitiveClosure}: assert every relative import edge
 * out of a precached chunk lands inside the closure. Throws (fails the
 * build) if a precached chunk references an emitted chunk that wasn't
 * included — converting a silent offline break into a build error.
 */
const assertClosureComplete = (closure, {exists, readFile}) => {
  const inClosure = new Set(closure)
  const missing = new Set()
  for (const rel of closure) {
    for (const match of readFile(rel).matchAll(VERIFY_REL_SPEC)) {
      const dep = posix.normalize(posix.join(posix.dirname(rel), match[1]))
      if (exists(dep) && !inClosure.has(dep)) missing.add(`${rel} -> ${dep}`)
    }
  }
  if (missing.size > 0) {
    throw new Error(
      '[precache] lazy-precache closure is INCOMPLETE — a precached chunk ' +
      'imports an emitted chunk that was not included, so it would 404 ' +
      'offline. The import-walk likely missed a form (multi-line or dynamic ' +
      `import). Missing edges:\n  ${[...missing].join('\n  ')}`,
    )
  }
}

/**
 * Resolve the transitive closure of `entryRelPaths` (dist-relative POSIX
 * paths) over static relative imports.
 *
 * @param {string[]} entryRelPaths - entry chunks; each MUST exist on disk
 *   (a missing one means the build's chunk layout drifted — throws so the
 *   build fails loudly rather than silently shipping a broken precache).
 * @param {{exists: (rel: string) => boolean, readFile: (rel: string) => string}} fs
 * @returns {string[]} every reachable chunk (incl. the entries), sorted.
 */
export const transitiveClosure = (entryRelPaths, {exists, readFile}) => {
  const seen = new Set()
  const stack = []

  for (const rel of entryRelPaths) {
    const norm = posix.normalize(rel)
    if (!exists(norm)) {
      throw new Error(`[precache] expected lazy precache entry missing: ${norm}`)
    }
    stack.push(norm)
  }

  while (stack.length > 0) {
    const rel = stack.pop()
    if (seen.has(rel)) continue
    seen.add(rel)
    for (const spec of relativeImports(readFile(rel))) {
      const dep = posix.normalize(posix.join(posix.dirname(rel), spec))
      if (seen.has(dep)) continue
      // A spec that doesn't resolve to an emitted file is almost certainly
      // a `from "..."` inside the module body, not a real edge — skip it
      // (genuine bundler edges always exist) rather than fail the build.
      if (!exists(dep)) continue
      stack.push(dep)
    }
  }

  const closure = [...seen].sort()
  // Backstop: fail loudly if the precise walk missed any edge (e.g. a
  // dynamic import, or a form the regex doesn't model) rather than ship a
  // chunk that 404s offline.
  assertClosureComplete(closure, {exists, readFile})
  return closure
}
