import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import ambientAccessors from '../../eslint-rules/ambient-accessors.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

const importEntry = {
  kind: 'import',
  module: '@/data/repoProvider',
  names: ['getActiveUserId'],
  message: 'use repo.user.id instead',
  allowIn: ['src/data/repoProvider.ts', 'src/plugins/attachments/assetUpload.ts'],
}

const memberEntry = {
  kind: 'member',
  object: 'navigator',
  property: 'platform',
  message: 'use isMacPlatform() instead',
  allowIn: ['src/utils/platform.ts'],
}

const literalEntry = {
  kind: 'literal',
  value: '(mock-breakpoint: 767px)',
  message: 'use MOBILE_BREAKPOINT_QUERY instead',
  allowIn: ['src/utils/viewport.ts'],
}

describe('ambient-accessors ESLint rule', () => {
  ruleTester.run('ambient-accessors', ambientAccessors.rules['ambient-accessors'], {
    valid: [
      // No entries configured — nothing to flag.
      {
        code: `import { getActiveUserId } from '@/data/repoProvider'`,
        options: [{ entries: [] }],
      },
      // An unrelated import is unaffected.
      {
        code: `import { useUser } from '@/data/repoProvider'`,
        options: [{ entries: [importEntry] }],
      },
      // The accessor's own allowlisted module.
      {
        filename: '/repo/src/data/repoProvider.ts',
        code: `import { getActiveUserId } from '@/data/repoProvider'`,
        options: [{ entries: [importEntry] }],
      },
      {
        filename: '/repo/src/plugins/attachments/assetUpload.ts',
        code: `import { getActiveUserId } from '@/data/repoProvider.js'`,
        options: [{ entries: [importEntry] }],
      },
      // Allowlisted member/literal files.
      {
        filename: '/repo/src/utils/platform.ts',
        code: `export const isMac = navigator.platform.includes('Mac')`,
        options: [{ entries: [memberEntry] }],
      },
      {
        filename: '/repo/src/utils/viewport.ts',
        code: `export const q = '(mock-breakpoint: 767px)'`,
        options: [{ entries: [literalEntry] }],
      },
      // A different member/literal is unaffected.
      {
        code: `export const isIOS = navigator.userAgent.includes('iPhone')`,
        options: [{ entries: [memberEntry] }],
      },
      {
        code: `export const q = '(min-width: 1024px)'`,
        options: [{ entries: [literalEntry] }],
      },
      // A multi-substitution template literal isn't a "single quasi"
      // breakpoint literal, so it's unaffected.
      {
        code: 'export const q = `(max-width: ${bp}px)`',
        options: [{ entries: [literalEntry] }],
      },
      // Namespace-import access to a name the entry does NOT restrict is
      // unaffected — only `entry.names` members are tracked.
      {
        filename: '/repo/src/plugins/foo.ts',
        code: `import * as provider from '@/data/repoProvider'\nprovider.useUser()`,
        options: [{ entries: [importEntry] }],
      },
    ],
    invalid: [
      // kind:'import' — bare specifier.
      {
        filename: '/repo/src/plugins/foo.ts',
        code: `import { getActiveUserId } from '@/data/repoProvider'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — .js-suffixed specifier.
      {
        filename: '/repo/src/plugins/foo.ts',
        code: `import { getActiveUserId } from '@/data/repoProvider.js'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — relative import from a NON-allowlisted file in the
      // module's own directory.
      {
        filename: '/repo/src/data/otherFile.ts',
        code: `import { getActiveUserId } from './repoProvider'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — relative import from elsewhere in the tree, matched
      // by the path-ending suffix (the gap block-subscriptions.js's
      // isPropertiesSource already closes for its own domain).
      {
        filename: '/repo/src/plugins/foo/bar.ts',
        code: `import { getActiveUserId } from '../../data/repoProvider'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'member' — plain dot access.
      {
        code: `export const isMac = navigator.platform.includes('Mac')`,
        options: [{ entries: [memberEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'member' — computed string access (closes the selector gap).
      {
        code: `export const isMac = navigator['platform'].includes('Mac')`,
        options: [{ entries: [memberEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'literal' — plain string literal.
      {
        code: `export const q = window.matchMedia('(mock-breakpoint: 767px)')`,
        options: [{ entries: [literalEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'literal' — no-substitution template form (closes the
      // selector gap).
      {
        code: 'export const q = window.matchMedia(`(mock-breakpoint: 767px)`)',
        options: [{ entries: [literalEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // Non-allowlisted file, even one that "looks like" the accessor's
      // module (endsWith matching is deliberately suffix-based, but the
      // file below simply isn't on the list).
      {
        filename: '/repo/src/plugins/attachments/assetDownLane.ts',
        code: `import { getActiveUserId } from '@/data/repoProvider'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — a PARENT-relative import from a directory nested
      // under the module's own dir (`src/data/internals/foo.ts` importing
      // `../repoProvider`), resolved rather than suffix/same-dir matched.
      {
        filename: '/repo/src/data/internals/foo.ts',
        code: `import { getActiveUserId } from '../repoProvider'`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — namespace import, then a member access on one of
      // the restricted `names`.
      {
        filename: '/repo/src/plugins/foo.ts',
        code: `import * as provider from '@/data/repoProvider'\nprovider.getActiveUserId()`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'import' — namespace import via the .js-suffixed specifier,
      // computed-string member access.
      {
        filename: '/repo/src/plugins/foo.ts',
        code: `import * as provider from '@/data/repoProvider.js'\nprovider['getActiveUserId']()`,
        options: [{ entries: [importEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'member' — window.<object>.<property> wrapper (dot form).
      {
        code: `export const isMac = window.navigator.platform.includes('Mac')`,
        options: [{ entries: [memberEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'member' — globalThis.<object>.<property> wrapper.
      {
        code: `export const isMac = globalThis.navigator.platform.includes('Mac')`,
        options: [{ entries: [memberEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
      // kind:'member' — window.<object>.<property> wrapper, computed
      // (bracket) final step.
      {
        code: `export const isMac = window.navigator['platform'].includes('Mac')`,
        options: [{ entries: [memberEntry] }],
        errors: [{ messageId: 'ambientAccess' }],
      },
    ],
  })
})
