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
 *   - PLUGIN = `src/plugins/<name>/**`. One directory per plugin; of the 604
 *     files under it, 113 import a SIBLING plugin (measured by resolving alias,
 *     relative and dynamic specifiers and excluding self-references — a naive
 *     substring count says 123, but 382 of those files reference only their OWN
 *     plugin via the `@/plugins/<self>/…` alias). Sibling imports are exactly
 *     what the principle permits, so a file inside a plugin is never a violator
 *     here. A loose file directly under `src/plugins/` is NOT a plugin — see
 *     `isInsidePlugin`.
 *   - CORE / KERNEL = everything else under `src/` — `src/facets` (the facet
 *     kernel), `src/data` (`kernelDataExtension` and friends), `src/components`,
 *     `src/editor`, `src/hooks`, `src/markdown`, `src/shortcuts`, `src/sync`,
 *     `src/utils`, and the app-layer half of `src/extensions`. The repo uses
 *     "kernel" and "core" for the same half of this line — `data/mutators.ts`
 *     exports `KERNEL_MUTATORS`, `data/kernelDataExtension.ts` calls itself "the
 *     single source of the kernel mutators, queries, … expressed as facet
 *     contributions", and plugins add theirs alongside.
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
 * Known gaps, deliberate:
 *   - a specifier that isn't statically known (`` import(`@/plugins/${id}/x.js`) ``
 *     — a template with INTERPOLATIONS; a no-substitution template is static and
 *     is checked) can't be resolved, so it is dropped rather than guessed at —
 *     the same "give up on the dynamic part" contract as
 *     no-raw-synced-table-writes. Nothing in `src/` loads a plugin that way.
 *   - a static specifier passed to a helper that does the `import()` one call
 *     frame away (`load('@/plugins/todo/x.js')`) — the literal never reaches an
 *     import node, and chasing it needs interprocedural analysis a single-file
 *     AST rule doesn't have. No such loader exists in `src/` today.
 */

import { posix } from 'node:path'

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

/** The linted file's path relative to `src/`, resolved against the project root
 *  (`context.cwd`). `undefined` outside `src/` — such a file is in neither
 *  layer, so the rule has nothing to say about it.
 *
 *  Anchored on the cwd rather than on a `src` path SEGMENT because both segment
 *  heuristics are wrong in opposite directions: `indexOf('src')` breaks when the
 *  repo lives under a directory named `src` (`/Users/me/src/repo/src/x.ts`),
 *  while `lastIndexOf('src')` breaks on a `src` nested INSIDE the tree —
 *  `src/plugins/foo/src/index.ts` reduced to `index.ts`, which reads as core, so
 *  that plugin file would have been denied the sibling-plugin imports the
 *  principle grants it. A relative-path resolve has neither failure mode. */
const srcRelativePath = (filename, cwd) => {
  const relative = posix.relative(normalizePath(cwd), filename)
  if (relative.startsWith('../') || posix.isAbsolute(relative)) return undefined
  return relative.startsWith('src/') ? relative.slice('src/'.length) : undefined
}

/** A module-file extension, used to tell `plugins/registry.js` (a loose FILE)
 *  from `plugins/todo` (a plugin BARREL — the form the composition root
 *  imports). */
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/

/** The plugin a src-relative path belongs to, or undefined. `plugins` must be
 *  a whole leading segment, so `pluginIds.ts` and `pluginValuePresets` don't
 *  match. The `^` anchor is also what rejects a path that climbed out of `src/`
 *  (`../scripts/plugins/x`) — the `../../scripts/plugins/` case in the test
 *  suite pins exactly that, so don't drop the anchor thinking a separate
 *  out-of-tree guard covers it. There isn't one; this is it.
 *
 *  A bare `plugins/<name>` with no further segment is the plugin's barrel
 *  (`import { todoPlugin } from '@/plugins/todo'` — how every registration in
 *  the composition root is written), so it counts. A bare `plugins/<name>.ts`
 *  does NOT: that is a loose file directly under `src/plugins/`, which
 *  `isInsidePlugin` already classifies as CORE, so importing one from core is a
 *  core→core edge. The two functions have to agree, or the rule would forbid an
 *  import while treating its target as core. */
const owningPlugin = (srcRelative) => {
  const [, name, separator] = srcRelative?.match(/^plugins\/([^/]+)(\/|$)/) ?? []
  if (name === undefined) return undefined
  return separator === '' && MODULE_EXTENSION.test(name) ? undefined : name
}

/** Whether the LINTED FILE lives inside a plugin. Deliberately stricter than
 *  `owningPlugin`: a loose file directly under `src/plugins/` is shared
 *  plugin-system infra, not a plugin, so it stays CORE and keeps getting
 *  checked. Without the trailing `/`, adding `src/plugins/registry.ts` would
 *  silently exempt itself from the boundary it helps define. */
const isInsidePlugin = (srcRelative) => /^plugins\/[^/]+\//.test(srcRelative)

/** Exact match on the `src/`-relative path. NOT `endsWith` on the raw filename:
 *  a suffix test isn't anchored to a path boundary, so a directory merely
 *  *ending* in "src" (`src/xsrc/extensions/staticAppExtensions.ts`) matched the
 *  allowlist entry `src/extensions/staticAppExtensions.ts` and silently
 *  exempted an unrelated file. An exemption that over-fires is worse than no
 *  exemption — it's invisible. */
const isAllowedFile = (importerSrcRelative, allowIn = []) =>
  allowIn.some(allowed => normalizePath(allowed) === `src/${importerSrcRelative}`)

/** A src-relative path, normalized, or undefined if it escapes `src/`. Every
 *  branch of `resolveSpecifier` goes through this: the relative branch used to
 *  get normalization for free from `posix.join` while the alias branch did raw
 *  string slicing, which meant `@/./plugins/x` and `@/plugins//x` (both of
 *  which the bundler resolves into the plugin layer) slipped through, and
 *  `@/plugins/../data/repo.js` — pure core — was reported as importing a plugin
 *  named `..`. */
const withinSrc = (path) => {
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized
}

/** Resolve an import specifier to a src-relative path, or undefined when it
 *  can't point inside `src/` (a bare package name, or a relative climb out of
 *  the tree). The `/src/…` form is not hypothetical — it is what
 *  `import.meta.glob` patterns use (see `plugins/agent-runtime/authoringCatalog.ts`). */
const resolveSpecifier = (source, importerSrcRelative) => {
  const specifier = normalizePath(source)
  if (specifier.startsWith('@/')) return withinSrc(specifier.slice(2))
  if (specifier.startsWith('/src/')) return withinSrc(specifier.slice('/src/'.length))
  if (specifier.startsWith('src/')) return withinSrc(specifier.slice('src/'.length))
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return withinSrc(posix.join(posix.dirname(importerSrcRelative), specifier))
  }
  return undefined
}

/** The static string a node contributes, or undefined. A no-substitution
 *  template literal — `` import(`@/plugins/todo/index.js`) `` — is every bit as
 *  static as a quoted string and resolves to exactly one module, so it counts;
 *  only a template with interpolations is genuinely dynamic and drops out. */
const staticString = (node) => {
  const el = node?.type === 'TSLiteralType' ? node.literal : node
  if (el?.type === 'Literal') return typeof el.value === 'string' ? el.value : undefined
  if (el?.type === 'TemplateLiteral' && el.expressions.length === 0) {
    return el.quasis[0].value.cooked
  }
  return undefined
}

/** The static string specifiers a node contributes — one, or an array of them
 *  (`import.meta.glob([...])` takes either). Array holes (`['a', , 'b']`) and
 *  non-static elements drop out. Negated glob patterns (`!…`) are exclusions,
 *  not dependencies, so they drop out too. */
const specifierLiterals = (node) => {
  const elements = node?.type === 'ArrayExpression' ? node.elements : [node]
  return elements
    .map(staticString)
    .filter(value => value !== undefined && !value.startsWith('!'))
}

/** Whether a resolved `import.meta.glob` PATTERN can expand into the plugin
 *  layer. `owningPlugin` is the wrong test for a glob: it reads the pattern as
 *  a literal path, so `**` + `/*.ts` and `{components,plugins}/**` — both of
 *  which Vite expands into `src/plugins` — came back "not a plugin" and the
 *  broadest globs sailed through while only the explicitly-`plugins/`-prefixed
 *  one was caught.
 *
 *  Only the FIRST segment decides whether `src/plugins` is reachable at all, so
 *  that is all this inspects. Deliberately conservative: a `*` in the first
 *  segment matches the `plugins` directory like any other, so it counts even
 *  though the rest of the pattern might exclude every real plugin file. A glob
 *  is a coarse dependency by nature; a false alarm here is cheap to silence
 *  inline, a miss is invisible. */
const globReachesPluginLayer = (pattern) => {
  const first = pattern?.split('/')[0]
  if (first === undefined) return false
  return first === 'plugins'
    || first.includes('*')
    || /\{[^}]*\bplugins\b[^}]*\}/.test(first)
}

/** `new URL('…', import.meta.url)` — Vite's idiom for referencing a worker,
 *  wasm module or asset by path. It is not an import node, but Vite's static
 *  analysis turns it into an emitted chunk, so it creates exactly the same
 *  non-removable build-time edge. Also covers `new Worker(new URL(…))`, whose
 *  inner expression is this same node. */
const isImportMetaUrl = (node) =>
  node?.type === 'NewExpression'
  && node.callee?.name === 'URL'
  && node.arguments[1]?.type === 'MemberExpression'
  && node.arguments[1].object?.type === 'MetaProperty'
  && node.arguments[1].property?.name === 'url'

const isImportMetaGlob = (callee) =>
  callee?.type === 'MemberExpression'
  && callee.object?.type === 'MetaProperty'
  && callee.object.meta?.name === 'import'
  && callee.object.property?.name === 'meta'
  && (callee.property?.name === 'glob' || callee.property?.name === 'globEager')

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
        // `src/`-relative paths (matched EXACTLY) that may import plugins
        // anyway: the composition root, and nothing else by default.
        allowIn: {type: 'array', items: {type: 'string'}},
      },
      additionalProperties: false,
    }],
    messages: {
      coreImportsPlugin:
        'Core cannot depend on plugins (plugins depend on core and on each other — never the reverse). This core module imports the `{{plugin}}` plugin via `{{specifier}}`, which makes that plugin non-removable and turns its seam into a hard edge. Do one of: (1) move the shared contract DOWN into core (`@/facets`, `@/data/api`, `@/utils`) and let the plugin import it from there; (2) INVERT it — declare a facet in core that the plugin contributes to, so core never names the plugin; (3) move this module INTO the plugin layer, since needing plugin code is evidence it belongs there. Registering plugins with the app is the composition root\'s job — new plugin wiring goes in `src/extensions/staticAppExtensions.ts` / `staticDataExtensions.ts`. If this import is genuinely unavoidable, add `// eslint-disable-next-line boundary/no-core-to-plugin-imports -- <why>`.',
      coreGlobsPluginLayer:
        'Core cannot depend on plugins, and a glob over the plugin layer (`{{specifier}}`) is the strongest form of it — core enumerating every plugin at build time. Nothing stays removable. Invert it: declare a facet in core and let each plugin contribute, or let the composition root (`src/extensions/staticAppExtensions.ts` / `staticDataExtensions.ts`) do the enumerating, which is its job. If this glob is genuinely unavoidable, add `// eslint-disable-next-line boundary/no-core-to-plugin-imports -- <why>`.',
    },
  },
  create(context) {
    const filename = getFilename(context)
    const importerSrcRelative = srcRelativePath(filename, context.cwd ?? process.cwd())

    // Only CORE files can violate this: a file outside `src/` isn't in either
    // layer, and a plugin importing a plugin is explicitly allowed. Checking
    // here (rather than relying only on the eslint.config.js `files` scope)
    // keeps the rule correct wherever it is switched on.
    if (importerSrcRelative === undefined) return {}
    if (isInsidePlugin(importerSrcRelative)) return {}
    if (isAllowedFile(importerSrcRelative, context.options[0]?.allowIn)) return {}

    /** `node` is what gets reported — always the whole statement/expression, so
     *  an `eslint-disable-next-line` sits above a multi-line import rather than
     *  inside its braces. */
    const check = (node, sourceNode) => {
      for (const specifier of specifierLiterals(sourceNode)) {
        const plugin = owningPlugin(resolveSpecifier(specifier, importerSrcRelative))
        if (plugin === undefined) continue
        context.report({node, messageId: 'coreImportsPlugin', data: {plugin, specifier}})
      }
    }

    /** Globs need their own classifier — see `globReachesPluginLayer`. A
     *  pattern names no single plugin, so the message names the layer. */
    const checkGlob = (node, sourceNode) => {
      for (const specifier of specifierLiterals(sourceNode)) {
        if (!globReachesPluginLayer(resolveSpecifier(specifier, importerSrcRelative))) continue
        context.report({node, messageId: 'coreGlobsPluginLayer', data: {specifier}})
      }
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
      // type X = import('…').Y. Under the pinned typescript-eslint the
      // specifier is always `node.source`; `argument` (a deprecated alias that
      // yields a TSLiteralType, which `specifierLiterals` unwraps) is accepted
      // purely as defence in depth against a parser bump. That fallback is
      // unreachable today and therefore untested — do not read it as
      // load-bearing.
      TSImportType: (node) => check(node, node.source ?? node.argument),
      // `import.meta.glob('/src/plugins/*/…')` — pattern-based discovery of the
      // whole plugin layer, and `require('…')`. Neither is an import *node*, so
      // neither is reachable from the handlers above; `import.meta.glob` in
      // particular is already idiomatic in this repo
      // (plugins/agent-runtime/authoringCatalog.ts), which makes it the shape a
      // core module is most likely to reach for to "find all the plugins".
      CallExpression: (node) => {
        if (isImportMetaGlob(node.callee)) checkGlob(node, node.arguments[0])
        else if (node.callee?.name === 'require') check(node, node.arguments[0])
      },
      // `new URL('…', import.meta.url)`, incl. inside `new Worker(...)`.
      NewExpression: (node) => isImportMetaUrl(node) && check(node, node.arguments[0]),
    }
  },
}

export default {
  rules: {
    'no-core-to-plugin-imports': noCoreToPluginImports,
  },
}
