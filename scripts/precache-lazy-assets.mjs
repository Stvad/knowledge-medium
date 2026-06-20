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
const FROM_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^\n;'"`]*?\bfrom\s*["'](\.[^"']*)["']/g
const BARE_IMPORT = /(?:^|\n)\s*import\s*["'](\.[^"']*)["']/g

const relativeImports = (source) => {
  const specs = new Set()
  for (const re of [FROM_IMPORT, BARE_IMPORT]) {
    for (const match of source.matchAll(re)) specs.add(match[1])
  }
  return [...specs]
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

  return [...seen].sort()
}
