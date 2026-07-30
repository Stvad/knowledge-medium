import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import kernelPluginBoundary from '../../eslint-rules/kernel-plugin-boundary.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

// Every case names a real-ish file, because the rule decides core-vs-plugin
// from the linted file's path. RuleTester's default filename is outside `src/`
// entirely, so an accidentally-unset filename would make a case pass vacuously
// — hence the explicit `filename` everywhere below.
//
// Rooted at the real cwd because the rule resolves paths against `context.cwd`
// (which RuleTester defaults to `process.cwd()`), not against a `src` path
// segment — see `srcRelativePath` for why the segment heuristics were wrong.
const repoPath = (name: string) => `${process.cwd()}/${name}`
const core = (name: string) => repoPath(`src/${name}`)
const plugin = (name: string) => repoPath(`src/plugins/${name}`)

const rule = kernelPluginBoundary.rules['no-core-to-plugin-imports']

describe('no-core-to-plugin-imports ESLint rule', () => {
  ruleTester.run('no-core-to-plugin-imports', rule, {
    valid: [
      // Core importing core is the whole point of core.
      {
        filename: core('extensions/appUpdateMount.tsx'),
        code: `import { keyedMapFacet } from '@/facets/facet.js'`,
      },
      {
        filename: core('extensions/appUpdateMount.tsx'),
        code: `import { repo } from '../data/repo.js'`,
      },
      // The other half of the principle: a plugin MAY depend on another plugin
      // (113 files in src/plugins do). Both cases hit the same `isInsidePlugin`
      // early return — the rule registers no visitors at all for a file inside
      // a plugin — so the second is a statement of intent about relative-path
      // sibling imports, not extra branch coverage.
      {
        filename: plugin('backlinks/index.ts'),
        code: `import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.js'`,
      },
      {
        filename: plugin('backlinks/index.ts'),
        code: `import { backlinksViewFacet } from '../backlinks-view/facet.js'`,
      },
      // Outside `src/` entirely (scripts/, packages/) the rule has nothing to
      // say — it isn't in either layer. Pins the `importerSrcRelative ===
      // undefined` early return, which the rule self-checks rather than
      // relying on the eslint.config.js `files` scope.
      {
        filename: repoPath('scripts/attachments-rls-verify.ts'),
        code: `import { isAlreadyExists } from '@/plugins/attachments/blobStore'`,
      },
      // A `src` directory nested INSIDE a plugin is still the plugin layer, so
      // its sibling-plugin imports stay legal. The `lastIndexOf('src')` segment
      // heuristic reduced this path to `index.ts`, read it as core, and denied
      // the plugin an import the principle explicitly grants it.
      {
        filename: plugin('foo/src/index.ts'),
        code: `import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.js'`,
      },
      // (The mirror hazard — a repo checked out under a directory literally
      // named `src` — is handled by construction, since `posix.relative`
      // against the cwd never inspects segment names. RuleTester can't vary
      // the cwd per case, so there is deliberately no test claiming to cover
      // it.)
      // `@/plugins/../data/repo.js` resolves to pure core. Before the alias
      // branch was normalized this was reported as importing a plugin named
      // `..` — a false positive on a path with no plugin in it at all.
      {
        filename: core('data/repo.ts'),
        code: `import { x } from '@/plugins/../data/repo.js'`,
      },
      // A glob that doesn't reach the plugin layer is fine, and a negated
      // pattern is an exclusion rather than a dependency.
      {
        filename: core('extensions/apiCatalog.ts'),
        code: `const m = import.meta.glob('/src/components/ui/*.tsx', { eager: true })`,
      },
      {
        filename: core('extensions/apiCatalog.ts'),
        code: `const m = import.meta.glob(['/src/components/**', '!/src/plugins/**'])`,
      },
      // `new URL` against something other than `import.meta.url` is an ordinary
      // runtime URL, not a build-time module reference.
      {
        filename: core('data/repo.ts'),
        code: `const u = new URL('@/plugins/todo/worker.ts', base)`,
      },
      // A loose file directly under `src/plugins/` is CORE (see isInsidePlugin),
      // so importing one from core is a core→core edge. `owningPlugin` has to
      // agree with `isInsidePlugin` here, or the rule would forbid an import
      // whose target it simultaneously treats as core.
      {
        filename: core('data/repo.ts'),
        code: `import { registry } from '@/plugins/registry.js'`,
      },
      // A plugin depending on core (the sanctioned direction).
      {
        filename: plugin('todo/schema.ts'),
        code: `import type { Repo } from '@/data/repo.js'`,
      },
      // The composition root is exempt by path: wiring every plugin into the
      // app is precisely its job.
      {
        filename: core('extensions/staticAppExtensions.ts'),
        code: `import { todoPlugin } from '@/plugins/todo'`,
        options: [{ allowIn: ['src/extensions/staticAppExtensions.ts'] }],
      },
      // `plugins` must be a whole path segment — a module whose name merely
      // starts with "plugin" is not the plugin layer.
      {
        filename: core('extensions/core.ts'),
        code: `import { pluginBlockId } from '@/extensions/pluginIds.js'`,
      },
      // ...and a whole LEADING segment. A core directory that merely contains
      // one is core. No such directory exists today, but `markdown/plugins/`
      // for remark/rehype plugins is an obvious name for one — this is what
      // the `^` anchor in `owningPlugin` is actually for.
      {
        filename: core('markdown/extensions.ts'),
        code: `import { remarkFoo } from '@/markdown/plugins/remarkFoo/index.js'`,
      },
      // The overwhelmingly common import shape: a bare package specifier is not
      // a path into `src/` at all.
      {
        filename: core('data/repo.ts'),
        code: `import { z } from 'zod'`,
      },
      // An alias that climbs OUT of `src/` — a real idiom here, three files
      // import `@/../vite-plugins/…`. Pins `withinSrc`'s out-of-tree branch,
      // which is what rejects these (not the anchor in `owningPlugin`).
      {
        filename: core('data/repo.ts'),
        code: `import { injectThemeBootDefaults } from '@/../vite-plugins/injectThemeBootDefaults'`,
      },
      // A relative specifier that climbs out of `src/` entirely can't be a
      // plugin import, however many `plugins` segments the name suggests.
      {
        filename: core('data/repo.ts'),
        code: `import x from '../../scripts/plugins/thing.js'`,
      },
      // Non-string sources (a template-literal dynamic import) are dropped
      // rather than guessed at.
      {
        filename: core('extensions/dynamicExtensions.ts'),
        // Single-quoted so the `${name}` reaches the linted source as a literal
        // template placeholder — that unresolvable specifier IS the case.
        code: 'const m = await import(`@/plugins/${name}/index.js`)',
      },
    ],
    invalid: [
      // The live violations this rule was written for.
      {
        filename: core('extensions/appUpdateStatus.ts'),
        code: `import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'diagnostics', specifier: '@/plugins/diagnostics/facet.js' },
        }],
      },
      {
        filename: core('extensions/extensionPromptStatus.ts'),
        code: `import { OPEN_EXTENSIONS_SETTINGS_ACTION_ID } from '@/plugins/extensions-settings/actions.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'extensions-settings', specifier: '@/plugins/extensions-settings/actions.js' },
        }],
      },
      // A type-only import still couples core's typecheck to the plugin —
      // the contract belongs in core if core names it.
      {
        filename: core('data/targets.ts'),
        code: `import type { TodoStatus } from '@/plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      // Re-export is an import with extra steps.
      {
        filename: core('extensions/apiCatalog.ts'),
        code: `export type { TodoStatus } from '@/plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      {
        filename: core('extensions/apiCatalog.ts'),
        code: `export * from '@/plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      // Dynamic import — the obvious way to launder a static violation.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = await import('@/plugins/todo/schema.js')`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      // ...and its type-position twin.
      {
        filename: core('types.ts'),
        code: `type S = import('@/plugins/todo/schema.js').TodoStatus`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      // Relative specifiers are resolved, not pattern-matched, so climbing
      // into the plugin layer by `../` is caught at any depth.
      {
        filename: core('extensions/appUpdateStatus.ts'),
        code: `import { diagnosticsFacet } from '../plugins/diagnostics/facet.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'diagnostics', specifier: '../plugins/diagnostics/facet.js' },
        }],
      },
      {
        filename: core('data/internals/kernelQueries.ts'),
        code: `import { TODO_TYPE } from '../../plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '../../plugins/todo/schema.js' },
        }],
      },
      // `allowIn` exempts the listed FILE, not the directory it sits in — a
      // sibling of the composition root gets no free pass from it.
      {
        filename: core('extensions/appUpdateStatus.ts'),
        code: `import { todoPlugin } from '@/plugins/todo'`,
        options: [{ allowIn: ['src/extensions/staticAppExtensions.ts'] }],
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo' },
        }],
      },
      // `allowIn` matches the src-relative path EXACTLY. A suffix test isn't
      // anchored to a path boundary, so a directory merely ending in "src"
      // used to satisfy the allowlist entry and silently exempt this file.
      {
        filename: core('xsrc/extensions/staticAppExtensions.ts'),
        code: `import { todoPlugin } from '@/plugins/todo'`,
        options: [{ allowIn: ['src/extensions/staticAppExtensions.ts'] }],
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo' },
        }],
      },
      // A loose file directly under src/plugins/ is shared plugin-system infra,
      // not a plugin, so it stays CORE. Without the trailing-slash requirement
      // in `isInsidePlugin` it would exempt itself from the boundary it helps
      // define.
      {
        filename: plugin('registry.ts'),
        code: `import { todoPlugin } from '@/plugins/todo'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo' },
        }],
      },
      // The alias branch is normalized like the relative branch: both of these
      // resolve to the real `todo` plugin and used to slip through untouched.
      {
        filename: core('data/repo.ts'),
        code: `import { TODO_TYPE } from '@/./plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/./plugins/todo/schema.js' },
        }],
      },
      {
        filename: core('data/repo.ts'),
        code: `import { TODO_TYPE } from '@/plugins//todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins//todo/schema.js' },
        }],
      },
      // An alias carrying a `..` segment. Not a contrived shape here — the repo
      // already imports `@/../vite-plugins/…` in three files — so an alias that
      // climbs sideways into the plugin layer is a route a real author could
      // take without noticing they crossed the boundary.
      {
        filename: core('data/repo.ts'),
        code: `import { TODO_TYPE } from '@/extensions/../plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/extensions/../plugins/todo/schema.js' },
        }],
      },
      // Root-relative `/src/…`: not hypothetical — it is the form
      // `import.meta.glob` patterns use.
      {
        filename: core('data/repo.ts'),
        code: `import { TODO_TYPE } from '/src/plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '/src/plugins/todo/schema.js' },
        }],
      },
      {
        filename: core('data/repo.ts'),
        code: `import { TODO_TYPE } from 'src/plugins/todo/schema.js'`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: 'src/plugins/todo/schema.js' },
        }],
      },
      // Glob-based discovery of the whole plugin layer — the strongest form of
      // the violation, and idiomatic enough in this repo
      // (plugins/agent-runtime/authoringCatalog.ts) to be the shape a core
      // module would reach for. Gets its own message.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = import.meta.glob('/src/plugins/*/index.ts', { eager: true })`,
        errors: [{
          messageId: 'coreGlobsPluginLayer',
          data: { specifier: '/src/plugins/*/index.ts' },
        }],
      },
      // ...including the array form, where only the plugin-layer pattern fires.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = import.meta.glob(['/src/components/**', '/src/plugins/*/facet.ts'])`,
        errors: [{
          messageId: 'coreGlobsPluginLayer',
          data: { specifier: '/src/plugins/*/facet.ts' },
        }],
      },
      // A glob does not have to NAME the plugin layer to reach it. Vite expands
      // both of these into src/plugins, but reading the pattern as a literal
      // path said "no plugin here" — so the BROADEST globs were the ones that
      // got through while the explicit one was caught.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = import.meta.glob('/src/**/*.ts', { eager: true })`,
        errors: [{
          messageId: 'coreGlobsPluginLayer',
          data: { specifier: '/src/**/*.ts' },
        }],
      },
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = import.meta.glob('/src/{components,plugins}/**/*.ts')`,
        errors: [{
          messageId: 'coreGlobsPluginLayer',
          data: { specifier: '/src/{components,plugins}/**/*.ts' },
        }],
      },
      // The deprecated Vite spelling is handled too.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const m = import.meta.globEager('/src/plugins/*/index.ts')`,
        errors: [{
          messageId: 'coreGlobsPluginLayer',
          data: { specifier: '/src/plugins/*/index.ts' },
        }],
      },
      // `new URL('…', import.meta.url)` is Vite's idiom for a worker/wasm/asset
      // reference. Not an import node, but Vite emits a chunk for it, so the
      // build-time edge is just as real and just as non-removable.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const u = new URL('@/plugins/todo/worker.ts', import.meta.url)`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/worker.ts' },
        }],
      },
      // ...including wrapped in `new Worker(...)`, which is the same inner node.
      {
        filename: core('extensions/liveRuntime.ts'),
        code: `const w = new Worker(new URL('../plugins/todo/worker.ts', import.meta.url), { type: 'module' })`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '../plugins/todo/worker.ts' },
        }],
      },
      // A no-substitution template literal is exactly as static as a quoted
      // string — it resolves to one module. Only an INTERPOLATED template is
      // genuinely dynamic (see the valid case above).
      {
        filename: core('extensions/liveRuntime.ts'),
        code: 'const m = await import(`@/plugins/todo/schema.js`)',
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      {
        filename: core('data/repo.ts'),
        code: 'declare const require: (s: string) => unknown; const x = require(`@/plugins/todo/schema.js`)',
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
      // Bare `require()` is not an import node, so it needs its own handler.
      // Low practical risk in this pure-ESM app, but it was a silent hole.
      {
        filename: core('data/repo.ts'),
        code: `declare const require: (s: string) => unknown; const x = require('@/plugins/todo/schema.js')`,
        errors: [{
          messageId: 'coreImportsPlugin',
          data: { plugin: 'todo', specifier: '@/plugins/todo/schema.js' },
        }],
      },
    ],
  })
})
