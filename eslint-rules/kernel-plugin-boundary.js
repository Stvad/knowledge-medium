/**
 * no-core-to-plugin-imports — the central architecture principle, as a gate.
 *
 * **Core cannot depend on plugins. Plugins may depend on core, and on each
 * other.** The dependency arrow points one way: core declares seams (facets,
 * mutators, queries, actions, renderers) and plugins fill them. The moment a
 * core module names a plugin, the plugin stops being removable and the seam
 * stops being a seam.
 *
 * Existing as prose is not enough. This repo is built primarily by agents, and
 * the shape of the erosion is always the same: a core module needs one constant
 * or one type that happens to live in a plugin, the import is a single line, and
 * nothing objects. So the invariant is a lint error rather than a paragraph.
 *
 * Where the boundary is (derived from the layout, not asserted):
 *
 *   - PLUGIN = `src/plugins/<name>/**`. One directory per plugin; 123 files
 *     under it already import sibling plugins, which the principle explicitly
 *     permits, so a plugin file is never a violator here.
 *   - CORE / KERNEL = everything else under `src/` — `src/facets` (the facet
 *     kernel), `src/data` (`kernelDataExtension` and friends), `src/components`,
 *     `src/editor`, `src/hooks`, `src/markdown`, `src/shortcuts`, `src/sync`,
 *     `src/utils`, and the app-layer half of `src/extensions`. The repo uses
 *     "kernel" and "core" for the same half of this line (cf.
 *     `data/kernelDataExtension.ts`: "the kernel mutators … so plugins can add").
 *   - The COMPOSITION ROOT (`src/extensions/staticAppExtensions.ts`,
 *     `staticDataExtensions.ts`) is exempt by path via `allowIn`. Importing
 *     every plugin is not a leak there, it is the file's entire job.
 *
 * `scripts/` and `packages/` are deliberately out of scope (they are top-level
 * consumers that sit ABOVE both layers, like an entry point), and so are tests
 * — see the eslint.config.js overrides for why.
 *
 * What counts as depending: a static import, an `export … from`, a dynamic
 * `import()`, and a type-position `import('…')`. Type-only imports are flagged
 * too: `import type` still makes core's typecheck fail without the plugin
 * present, and a contract core names is a contract that belongs in core.
 *
 * Relative specifiers are RESOLVED against the linted file's directory (posix
 * join, same approach as ambient-accessors.js) rather than pattern-matched, so
 * `../plugins/x` from `src/extensions/` and `../../plugins/x` from
 * `src/data/internals/` are both caught, while `../../scripts/plugins/x` —
 * which climbs out of `src/` — is not.
 *
 * Known gap, deliberate: a specifier that isn't a static string
 * (`` import(`@/plugins/${id}/index.js`) ``) can't be resolved, so it is dropped
 * rather than guessed at — the same "give up on the dynamic part" contract as
 * no-raw-synced-table-writes. Nothing in `src/` loads a plugin that way today.
 */

import { posix } from 'node:path'

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

/** The linted file's repo-relative path, found by locating the `src` segment
 *  (filenames are either a real absolute path or a fabricated RuleTester one;
 *  both carry a literal `src/…` segment). `undefined` outside `src/` — such a
 *  file is neither core nor plugin, so the rule has nothing to say about it. */
const srcRelativePath = (filename) => {
  const parts = filename.split('/')
  const srcIndex = parts.lastIndexOf('src')
  return srcIndex === -1 ? undefined : parts.slice(srcIndex + 1).join('/')
}

const PLUGIN_SEGMENT = /^plugins\/([^/]+)(?:\/|$)/

/** The plugin a src-relative path belongs to, or undefined. `plugins` must be
 *  a whole leading segment, so `pluginIds.ts` and `pluginValuePresets` don't
 *  match. */
const owningPlugin = (srcRelative) => srcRelative?.match(PLUGIN_SEGMENT)?.[1]

const isAllowedFile = (filename, allowIn = []) =>
  allowIn.some(allowed => filename.endsWith(normalizePath(allowed)))

/** Resolve an import specifier to a src-relative path, or undefined when it
 *  can't point inside `src/` (a bare package name, or a relative climb out of
 *  the tree). */
const resolveSpecifier = (source, importerSrcRelative) => {
  const specifier = normalizePath(source)
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (specifier.startsWith('/src/')) return specifier.slice('/src/'.length)
  if (specifier.startsWith('src/')) return specifier.slice('src/'.length)
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = posix.join(posix.dirname(importerSrcRelative), specifier)
    // A climb past `src/` leaves a leading `../` — outside the tree, not a plugin.
    return resolved.startsWith('../') ? undefined : resolved
  }
  return undefined
}

const noCoreToPluginImports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Core must not import from src/plugins — the dependency arrow points from plugins to core, never back.',
    },
    schema: [{
      type: 'object',
      properties: {
        // Repo-relative paths (suffix-matched) that may import plugins anyway:
        // the composition root, and nothing else by default.
        allowIn: {type: 'array', items: {type: 'string'}},
      },
      additionalProperties: false,
    }],
    messages: {
      coreImportsPlugin:
        'Core cannot depend on plugins (plugins depend on core and on each other — never the reverse). This core module imports the `{{plugin}}` plugin via `{{specifier}}`, which makes that plugin non-removable and turns its seam into a hard edge. Do one of: (1) move the shared contract DOWN into core (`@/facets`, `@/data/api`, `@/utils`) and let the plugin import it from there; (2) INVERT it — declare a facet in core that the plugin contributes to, so core never names the plugin; (3) move this module INTO the plugin layer, since needing plugin code is evidence it belongs there. Registering plugins with the app is the composition root\'s job — new plugin wiring goes in `src/extensions/staticAppExtensions.ts` / `staticDataExtensions.ts`. If this import is genuinely unavoidable, add `// eslint-disable-next-line boundary/no-core-to-plugin-imports -- <why>`.',
    },
  },
  create(context) {
    const filename = getFilename(context)
    const importerSrcRelative = srcRelativePath(filename)

    // Only CORE files can violate this: a file outside `src/` isn't in either
    // layer, and a plugin importing a plugin is explicitly allowed. Checking
    // here (rather than relying only on the eslint.config.js `files` scope)
    // keeps the rule correct wherever it is switched on.
    if (importerSrcRelative === undefined) return {}
    if (owningPlugin(importerSrcRelative) !== undefined) return {}
    if (isAllowedFile(filename, context.options[0]?.allowIn)) return {}

    /** `node` is what gets reported — always the whole statement/expression, so
     *  an `eslint-disable-next-line` sits above a multi-line import rather than
     *  inside its braces. */
    const check = (node, sourceNode) => {
      // Older typescript-eslint wrapped a type-position specifier in a
      // TSLiteralType; unwrap before the Literal check so a parser bump in
      // either direction keeps working.
      const literal = sourceNode?.type === 'TSLiteralType' ? sourceNode.literal : sourceNode
      if (literal?.type !== 'Literal' || typeof literal.value !== 'string') return
      const plugin = owningPlugin(resolveSpecifier(literal.value, importerSrcRelative))
      if (plugin === undefined) return
      context.report({
        node,
        messageId: 'coreImportsPlugin',
        data: {plugin, specifier: literal.value},
      })
    }

    return {
      // import … from '…'
      ImportDeclaration: (node) => check(node, node.source),
      // export … from '…' / export * from '…' (a re-export is an import with
      // an extra step, and `export … from` is how a barrel would leak one).
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      // await import('…') — the obvious way to launder a static violation.
      ImportExpression: (node) => check(node, node.source),
      // type X = import('…').Y — typescript-eslint has named this specifier
      // `source` (current), `argument`, and `parameter` across versions; accept
      // all three so the rule survives a parser bump in either direction.
      TSImportType: (node) => check(node, node.source ?? node.argument ?? node.parameter),
    }
  },
}

export default {
  rules: {
    'no-core-to-plugin-imports': noCoreToPluginImports,
  },
}
