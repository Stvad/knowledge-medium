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
// from the linted file's path. RuleTester's default filename has no `src`
// segment at all, so an accidentally-unset filename would make a case pass
// vacuously — hence the explicit `filename` everywhere below.
const core = (name: string) => `/repo/src/${name}`
const plugin = (name: string) => `/repo/src/plugins/${name}`

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
      // The other half of the principle: a plugin MAY depend on another
      // plugin (123 files in src/plugins do), by alias or by relative path.
      {
        filename: plugin('backlinks/index.ts'),
        code: `import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.js'`,
      },
      {
        filename: plugin('backlinks/index.ts'),
        code: `import { backlinksViewFacet } from '../backlinks-view/facet.js'`,
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
    ],
  })
})
