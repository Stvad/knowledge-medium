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
 *   - PLUGIN = `src/plugins/<name>/**`. One directory per plugin, and well over
 *     a hundred of the files under it import a SIBLING plugin — exactly what the
 *     principle permits — so a file inside a plugin is never a violator here.
 *     (Deliberately not a precise tally: it drifts with every commit, and a
 *     grep for `@/plugins/` badly overcounts, since most files there reference
 *     only their OWN plugin through the `@/plugins/<self>/…` self-alias.)
 *     A loose file directly under `src/plugins/` is NOT a plugin — see
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
 * `import()`, a type-position `import('…')`, `require()`, `import.meta.glob`
 * over the plugin layer, and `new URL('…', import.meta.url)`. Type-only imports
 * are flagged too: `import type` still makes core's typecheck fail without the
 * plugin present, and a contract core names is a contract that belongs in core.
 *
 * Specifiers are RESOLVED, not pattern-matched — see `resolveSpecifier`. So
 * `../plugins/x` from `src/extensions/`, `../../plugins/x` from
 * `src/data/internals/`, and a path that leaves and re-enters the tree
 * (`@/../src/plugins/x`) are all caught, while `../../scripts/plugins/x` and
 * `@/plugins/../data/repo.js` — which genuinely land outside the plugin layer —
 * are not.
 *
 * Known gaps, deliberate:
 *   - a specifier assembled at RUNTIME (`import(someVariable)`) can't be seen at
 *     all. Note this does NOT cover an interpolated template: Vite compiles
 *     `` import(`@/plugins/${id}/x.js`) `` into a static map of every match, so
 *     it is a glob and is checked as one (see `templateGlob`). An earlier
 *     version of this rule called that case unknowable; it isn't.
 *   - a static specifier passed to a helper that does the `import()` one call
 *     frame away (`load('@/plugins/todo/x.js')`) — the literal never reaches an
 *     import node, and chasing it needs interprocedural analysis a single-file
 *     AST rule doesn't have. No such loader exists in `src/` today.
 *   - `require` is matched by NAME, with no scope analysis, so a locally
 *     declared `require` that happens to take a plugin-shaped string would be
 *     flagged. Left alone deliberately: this app is pure ESM, so a real
 *     `require` call can't run at all, and adding scope analysis to tell the
 *     two apart would cost more than the false alarm it prevents.
 */

import { posix } from 'node:path'

const normalizePath = (value) => value.replaceAll('\\', '/')

// Under the pinned eslint, `context.filename` is always a string, so the
// fallbacks are unreachable — kept only to match the identical helper in the
// sibling rule files (ambient-accessors, block-subscriptions, child-view).
// Defence in depth, not load-bearing.
const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

/** The linted file's path relative to the source root. `undefined` outside it —
 *  such a file is in neither layer, so the rule has nothing to say about it.
 *
 *  Not a `src` path SEGMENT search, because both segment heuristics are wrong in
 *  opposite directions: `indexOf('src')` breaks when the repo lives under a
 *  directory named `src` (`/Users/me/src/repo/src/x.ts`), while
 *  `lastIndexOf('src')` breaks on a `src` nested INSIDE the tree —
 *  `src/plugins/foo/src/index.ts` reduced to `index.ts`, which reads as core, so
 *  that plugin file would have been denied the sibling-plugin imports the
 *  principle grants it.
 *
 *  Not derived from `context.cwd` either. That was the first fix and it FAILED
 *  OPEN: run `eslint` from `src/` (or any subdirectory) and every path escaped
 *  the cwd, so the rule quietly reported nothing at all — a guard that silently
 *  passes is worse than no guard. `pnpm run check` runs from the repo root so
 *  the gate was never actually blind, but an editor integration or a
 *  hand-invoked `eslint` needn't. `sourceRoot` is therefore passed explicitly
 *  from eslint.config.js (`import.meta.dirname`), which is exact and
 *  cwd-independent, and the schema marks it REQUIRED — a cwd-derived default
 *  just moved the same fail-open one level up, where any config that forgot the
 *  option would silently lint nothing.
 *
 *  Dormant limitation: `import.meta.dirname` resolves symlinks while ESLint's
 *  `context.filename` preserves them, so a checkout under a symlinked ancestor
 *  would make the two diverge and every file miss this prefix match. Not the
 *  case here (`pwd -P` == `pwd`); fixing it needs a realpath call, which is not
 *  worth filesystem access inside a lint rule until someone actually hits it. */
const srcRelativePath = (filename, sourceRoot) => {
  const relative = posix.relative(sourceRoot, filename)
  return outsideRoot(relative) ? undefined : relative
}

/** Tells `plugins/registry.js` or `plugins/shared.css` (a loose FILE) from
 *  `plugins/todo` (a plugin BARREL — the form the composition root imports).
 *  ANY extension, not a module-extension whitelist: the layer split says every
 *  loose file directly under `src/plugins/` is core, and Vite happily imports
 *  css/json/svg from there, so whitelisting `.ts`/`.js` made a core→core CSS
 *  import report as a plugin named `shared.css`.
 *
 *  The tradeoff is a plugin DIRECTORY whose name contains a dot — its bare
 *  barrel would read as a loose file. None exist (every plugin is kebab-case)
 *  and a false positive on ordinary asset imports is the likelier harm. */
const HAS_EXTENSION = /\.[^./]+$/

/** The plugin a src-relative path belongs to, or undefined. `plugins` must be
 *  a whole LEADING segment: `pluginIds.ts` doesn't match, and neither does a
 *  core directory that merely contains one (`markdown/plugins/remarkFoo.ts` —
 *  no such directory today, but that is an obvious name for one). Out-of-tree
 *  paths are rejected earlier, by `srcRelativePath`, not here.
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
  return separator === '' && HAS_EXTENSION.test(name) ? undefined : name
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

/** The absolute path a specifier points at, or undefined for a bare package
 *  name. ONE resolver for every form, because the alternative — a branch per
 *  shape, each reasoning in its own coordinate space — is what produced four
 *  separate "broad pattern escapes" bugs in this rule: a root-relative glob, a
 *  globby root segment, a brace spanning a `/`, and a pattern climbing above the
 *  source root and back in. Absolute space collapses all of them, because
 *  `posix.resolve` normalizes `..` and `//` for free and a path that leaves and
 *  re-enters lands where it actually lands.
 *
 *  Glob metacharacters ride through untouched — this is pure path arithmetic,
 *  so the same function serves module specifiers and glob patterns. */
const toAbsolute = (source, importerDir, sourceRoot) => {
  const specifier = normalizePath(source)
  const repoRoot = posix.dirname(sourceRoot)
  // Leading separators are stripped so `posix.resolve` can't be handed an
  // ABSOLUTE suffix, which would discard the base and send a real plugin import
  // off to a filesystem path outside the tree (`@//plugins/x`).
  const under = (base, rest) => posix.resolve(base, rest.replace(/^\/+/, ''))
  if (specifier.startsWith('@/')) return under(sourceRoot, specifier.slice(2))
  // Vite's filesystem-qualified form — the remainder is already absolute.
  if (specifier.startsWith('/@fs/')) return under('/', specifier.slice('/@fs/'.length))
  // Root-relative, i.e. relative to the Vite root. Not just `/src/…`: `/docs/…`
  // resolves too and is then correctly found to be outside the source root.
  if (specifier.startsWith('/')) return under(repoRoot, specifier)
  if (specifier.startsWith('src/')) return posix.resolve(repoRoot, specifier)
  if (specifier.startsWith('./') || specifier.startsWith('../')) return posix.resolve(importerDir, specifier)
  return undefined
}

/** The directory a src-relative file sits in, absolute. */
const absoluteDirOf = (srcRelative, sourceRoot) =>
  posix.dirname(posix.resolve(sourceRoot, srcRelative))

/** Resolve an import specifier to a src-relative path, or undefined when it
 *  can't point inside `src/`. */
const resolveSpecifier = (source, importerSrcRelative, sourceRoot) => {
  const absolute = toAbsolute(source, absoluteDirOf(importerSrcRelative, sourceRoot), sourceRoot)
  return absolute === undefined ? undefined : srcRelativePath(absolute, sourceRoot)
}

/** The static string a node contributes, or undefined. A no-substitution
 *  template literal — `` import(`@/plugins/todo/index.js`) `` — is every bit as
 *  static as a quoted string and resolves to exactly one module, so it counts;
 *  only a template with interpolations is genuinely dynamic and drops out. */
const staticString = (node) => {
  const el = node?.type === 'TSLiteralType' ? node.literal : node
  if (el?.type === 'Literal') return typeof el.value === 'string' ? el.value : undefined
  // A template whose interpolations are THEMSELVES static folds to one string,
  // exactly as literalSqlText does it: `` `/src/${'plugins'}` `` is knowable.
  if (el?.type === 'TemplateLiteral') {
    const parts = el.quasis.map(quasi => quasi.value.cooked)
    if (parts.some(part => part === null || part === undefined)) return undefined
    const filled = el.expressions.map(staticString)
    if (filled.some(part => part === undefined)) return undefined
    return parts.reduce((out, part, i) => out + (i === 0 ? '' : filled[i - 1]) + part, '')
  }
  // A `+` chain of static parts is as knowable as one literal, and Vite folds
  // it the same way. Same contract as no-raw-synced-table-writes' literalSqlText:
  // fold when BOTH sides are static, give up otherwise.
  if (el?.type === 'BinaryExpression' && el.operator === '+') {
    const left = staticString(el.left)
    const right = staticString(el.right)
    return left === undefined || right === undefined ? undefined : left + right
  }
  return undefined
}

/** The static string specifiers a node contributes — one, or an array of them
 *  (`import.meta.glob([...])` takes either). Array holes (`['a', , 'b']`) and
 *  non-static elements drop out. Negated glob patterns (`!…`) are KEPT — a
 *  caller that only wants dependencies can skip them, but `checkGlob` has to
 *  see them, since an exclusion can be what makes a broad pattern safe. */
/** The glob Vite compiles an INTERPOLATED specifier into — each `${…}` becomes
 *  a single-segment wildcard. `` import(`@/plugins/${id}/index.js`) `` is not
 *  unknowable: vite:dynamic-import-vars rewrites it into a static map of every
 *  matching module, which for that prefix is every plugin in the repo. So it is
 *  a glob wearing an import's clothes, and goes through the glob classifier. */
const templateGlob = (node) => {
  const el = node?.type === 'TSLiteralType' ? node.literal : node
  if (el?.type !== 'TemplateLiteral' || el.expressions.length === 0) return undefined
  const parts = el.quasis.map(quasi => quasi.value.cooked)
  return parts.some(part => part === null || part === undefined) ? undefined : parts.join('*')
}

const specifierLiterals = (node) => {
  const elements = node?.type === 'ArrayExpression' ? node.elements : [node]
  return elements
    .map(staticString)
    .filter(value => value !== undefined)
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
// Exclusions that remove the WHOLE plugin layer, so a broad positive alongside
// one of them depends on no plugin. Line comments, not JSDoc: these patterns
// contain `*` followed by `/`, which would close a block comment.
//
// `plugins` + `/*/` + `**` is equivalent to `plugins/**` under this rule's own
// definition — the only thing it leaves behind is a loose file directly under
// `src/plugins/`, which is core. An enumerated set rather than glob algebra: a
// narrower exclusion (`!plugins/todo/**`) leaves every other plugin in the
// expansion and must still report.
const CLEARS_PLUGIN_LAYER = new Set([
  'plugins/**', 'plugins/*/**', 'plugins/**/*',
  // Written project-wide rather than src-relative. It sweeps more than the
  // plugin layer, but it certainly sweeps all of it.
  '**/plugins/**',
])

const GLOB_METACHARACTER = /[*?[\](){}!+@]/

/** Expand the simple brace alternations in a glob segment into the literal
 *  candidates it can produce: `plugin{s,}` -> `plugins`, `plugin`, and
 *  `{components,plugins}` -> `components`, `plugins`. Only the first brace group
 *  is expanded, which is all a single path segment realistically carries. */
const expandBraces = (segment) => {
  const [, before, alternatives, after] = segment.match(/^([^{]*)\{([^{}]*)\}(.*)$/) ?? []
  if (alternatives === undefined) return [segment]
  return alternatives.split(',').map(alternative => `${before}${alternative}${after}`)
}

/** Whether one glob path segment can match a literal directory name.
 *  Conservative by design — see the note in `globReachesPluginRoot`. */
const segmentCanMatch = (segment, literal) =>
  expandBraces(segment).some(candidate =>
    // A literal `plugins`, or anything still holding a glob metacharacter.
    // Conservative on purpose: `[p]lugins`, `@(plugins|components)` and `**`
    // all expand into the plugin tree, and enumerating every glob dialect to
    // decide which ones can't is not worth it — a false alarm costs one inline
    // disable, a miss is invisible. `{components,ui}` expands to plain
    // literals and is correctly left alone.
    candidate === literal || GLOB_METACHARACTER.test(candidate))

/** Whether a glob PATTERN — already absolute — can match anything inside the
 *  plugin layer. Asked as one question in one coordinate space, instead of the
 *  per-shape branches that kept letting the broadest patterns through.
 *
 *  Three cases, and only three:
 *    1. the static head is already at or inside the plugin root — reaches;
 *    2. the static head is somewhere else entirely (a sibling, another tree) —
 *       a glob cannot climb sideways, so it never reaches;
 *    3. the static head is ABOVE the plugin root — the globby remainder has to
 *       span the gap, so match it segment by segment against the path down.
 *  A leading `**` spans any depth, and a brace group that survives the segment
 *  split unbalanced can't be reasoned about at all; both flag conservatively. */
/** Whether a glob's remaining segments can walk DOWN a concrete path — used to
 *  ask whether a pattern rooted above the plugin layer can reach into it.
 *
 *  `**` is zero-or-more segments, so it can swallow whatever is left of the gap
 *  and the answer is yes wherever it appears. Handling it only in the leading
 *  position — which is where the tests happened to put it — meant a zip
 *  comparison consumed it as exactly ONE segment and compared everything after
 *  it at the wrong depth. */
const canDescendTo = (patternSegments, gapSegments) => {
  if (gapSegments.length === 0) return true
  if (patternSegments.length === 0) return false
  const [first, ...rest] = patternSegments
  if (first === '**' || hasUnbalancedBrace(first)) return true
  return segmentCanMatch(first, gapSegments[0]) && canDescendTo(rest, gapSegments.slice(1))
}

const globReachesPluginRoot = (absolutePattern, pluginsRoot) => {
  if (absolutePattern === undefined) return false
  const {head, rest} = staticHead(absolutePattern)
  const headPath = posix.normalize(head)
  if (!outsideRoot(posix.relative(pluginsRoot, headPath))) return true
  const gap = posix.relative(headPath, pluginsRoot)
  if (outsideRoot(gap)) return false
  return canDescendTo(rest === '' ? [] : rest.split('/'), gap.split('/'))
}

/** Split a glob into its static leading segments and the globby remainder. */
const staticHead = (pattern) => {
  const segments = pattern.split('/')
  const globAt = segments.findIndex(segment => GLOB_METACHARACTER.test(segment))
  return globAt === -1
    ? {head: pattern, rest: ''}
    : {head: segments.slice(0, globAt).join('/'), rest: segments.slice(globAt).join('/')}
}

const outsideRoot = (relative) => relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)

const hasUnbalancedBrace = (segment) => segment.includes('{') && !segment.includes('}')

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
  // `new.target` is a MetaProperty too, so match the names — `new.target.url`
  // is an ordinary runtime base and Vite emits no chunk for it.
  && node.arguments[1].object.meta?.name === 'import'
  && node.arguments[1].object.property?.name === 'meta'
  && node.arguments[1].property?.name === 'url'

/** The value node of a named property on an object literal, or undefined. Used
 *  to read `import.meta.glob`'s `base` option; a computed or spread property is
 *  not statically known and drops out. */
const propertyValue = (objectNode, name) => {
  if (objectNode?.type !== 'ObjectExpression') return undefined
  // Last write wins, and a spread of an object LITERAL is statically known —
  // Vite evaluates it the same way. A spread of an identifier (`{...GLOB_OPTS}`)
  // needs scope analysis and is not resolved; that is the realistic shape, so
  // treat this as narrowing the gap rather than closing it.
  let found
  for (const property of objectNode.properties) {
    if (property.type === 'SpreadElement') {
      const nested = propertyValue(property.argument, name)
      if (nested !== undefined) found = nested
    } else if (
      property.type === 'Property'
      // A computed key that is itself a literal (`{['base']: …}`) names the
      // property just as plainly as `{base: …}`.
      && (property.computed
        ? property.key?.type === 'Literal' && property.key.value === name
        : (property.key?.name === name || property.key?.value === name))
    ) {
      found = property.value
    }
  }
  return found
}

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
      // `sourceRoot` is REQUIRED, so a config that forgets it fails loudly at
      // load time instead of silently linting nothing. Making it optional with
      // a cwd-derived default was the same fail-open bug one level up: the
      // shipped config passed it, so the gate worked, while any other config —
      // a nested one, an inline `--rule`, a copy of this rule elsewhere —
      // silently reintroduced it.
      required: ['sourceRoot'],
      properties: {
        // Absolute path to the source root (`<repo>/src`), from
        // `import.meta.dirname` — exact and cwd-independent.
        sourceRoot: {type: 'string'},
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
    const sourceRoot = normalizePath(context.options[0].sourceRoot)
    const importerSrcRelative = srcRelativePath(filename, sourceRoot)
    const importerDir = importerSrcRelative === undefined
      ? undefined
      : absoluteDirOf(importerSrcRelative, sourceRoot)

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
        const plugin = owningPlugin(resolveSpecifier(specifier, importerSrcRelative, sourceRoot))
        if (plugin === undefined) continue
        context.report({node, messageId: 'coreImportsPlugin', data: {plugin, specifier}})
      }
      // An interpolated specifier compiles to a glob (see `templateGlob`), so
      // it is reported as one — it pulls in every plugin that matches, not one.
      const glob = templateGlob(sourceNode)
      if (glob !== undefined
        && globReachesPluginRoot(
          toAbsolute(glob, importerDir, sourceRoot), posix.join(sourceRoot, 'plugins'),
        )) {
        context.report({node, messageId: 'coreGlobsPluginLayer', data: {specifier: glob}})
      }
    }

    /** Globs need their own classifier — see `globReachesPluginRoot`. A
     *  pattern names no single plugin, so the message names the layer. */
    const checkGlob = (node, sourceNode, optionsNode) => {
      const patterns = specifierLiterals(sourceNode)
      const repoRoot = posix.dirname(sourceRoot)
      const pluginsRoot = posix.join(sourceRoot, 'plugins')
      // `import.meta.glob('./todo/**', {base: '/src/plugins'})` resolves the
      // pattern under the base, not under the importing file. Kept ABSOLUTE: a
      // base outside the source root (`base: '../..'`) is perfectly legal and
      // used to fall back silently to the importer's own directory, quietly
      // resolving the pattern somewhere it does not live.
      const baseAbsolute = ((base) =>
        base === undefined ? undefined : toAbsolute(`${base}/`, importerDir, sourceRoot)
      )(staticString(propertyValue(optionsNode, 'base')))
      const patternDir = baseAbsolute ?? importerDir
      // A bare leading `**` is relative to the Vite root, not to the importer.
      const absolute = (pattern) => pattern.startsWith('**')
        ? posix.resolve(repoRoot, pattern)
        : toAbsolute(pattern, patternDir, sourceRoot)

      // `import.meta.glob(['/src/**', '!/src/plugins/**'])` reaches no plugin at
      // all — the exclusion is the whole point. Only a whole-layer spelling
      // clears the call: a narrower exclusion (`!/src/plugins/todo/**`) still
      // leaves every OTHER plugin in the expansion, so the author opts out
      // inline instead. Matched on the src-relative form when the pattern lands
      // inside `src/`, and on the raw text for the project-wide spelling.
      const clears = (pattern) => {
        const inside = srcRelativePath(absolute(pattern) ?? '', sourceRoot)
        return CLEARS_PLUGIN_LAYER.has(inside ?? posix.normalize(pattern))
      }
      if (patterns.some(p => p.startsWith('!') && clears(p.slice(1)))) return

      for (const specifier of patterns) {
        if (specifier.startsWith('!')) continue
        if (!globReachesPluginRoot(absolute(specifier), pluginsRoot)) continue
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
        if (isImportMetaGlob(node.callee)) checkGlob(node, node.arguments[0], node.arguments[1])
        else if (node.callee?.name === 'require') check(node, node.arguments[0])
      },
      // `new URL('…', import.meta.url)`, incl. inside `new Worker(...)`.
      NewExpression: (node) => isImportMetaUrl(node) && check(node, node.arguments[0]),
      // `/// <reference path="…" />`. Not a node at all — ESLint exposes it as a
      // comment — but TypeScript resolves and includes the target, so a core
      // .d.ts can pick up a plugin dependency the whole visitor set is blind to.
      // A live idiom here: src/vite-env.d.ts opens with one.
      Program: () => {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== 'Line') continue
          const [, referencePath] =
            comment.value.match(/^\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/) ?? []
          if (referencePath === undefined) continue
          // Reference paths are resolved relative to the containing file.
          const plugin = owningPlugin(
            srcRelativePath(posix.resolve(importerDir, normalizePath(referencePath)), sourceRoot),
          )
          if (plugin === undefined) continue
          context.report({
            loc: comment.loc,
            messageId: 'coreImportsPlugin',
            data: {plugin, specifier: referencePath},
          })
        }
      },
      // `declare module '@/plugins/todo/schema.js' { … }`. Augmenting a module
      // resolves it, so core's typecheck fails without the plugin — the same
      // coupling `import type` has. Not hypothetical here: augmenting
      // `@/data/api` is how plugins extend core (backlinks/query.ts), so the
      // reverse spelling is a shape someone would reach for.
      TSModuleDeclaration: (node) => node.id?.type === 'Literal' && check(node, node.id),
    }
  },
}

export default {
  rules: {
    'no-core-to-plugin-imports': noCoreToPluginImports,
  },
}
