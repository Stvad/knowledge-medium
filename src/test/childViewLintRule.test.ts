import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import childView from '../../eslint-rules/child-view.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

describe('child-view ESLint rule', () => {
  ruleTester.run(
    'require-explicit-child-view',
    childView.rules['require-explicit-child-view'],
    {
      valid: [
        // Query handles that opt into the visible view.
        { code: `const rows = repo.query.subtree({id: block.id, hidePropertyChildren: true})` },
        { code: `useHandle(repo.query.childIds({id, hydrate: true, hidePropertyChildren: true}))` },
        { code: `repo.query.children({id, hidePropertyChildren: true})` },
        // Explicit structural everything-view is also an explicit choice.
        { code: `repo.query.subtree({id: block.id, hidePropertyChildren: false})` },
        // The named helper is the sanctioned visible spelling.
        { code: `const rows = await visibleChildrenOf(tx, parentId, workspaceId)` },
        { code: `const kids = await tx.childrenOf(id, ws, {hidePropertyChildren: true})` },
        // Not the query-handle shape — an ordinary object/array member access.
        { code: `const first = slot.children[0]` },
        { code: `walk(node.subtree)` },
        // `{...}` without an `id` key is not a block query handle.
        { code: `widget.children({className: 'x'})` },
        // The semantic hooks (Identifier callee) are fine — they encapsulate the view.
        { code: `const ids = useChildIds(block)` },
        // Test files are skipped entirely.
        {
          filename: '/repo/src/components/Foo.test.tsx',
          code: `repo.query.subtree({id: block.id})`,
        },
        // `check: 'query'` (the default outside pure display dirs): the
        // low-level primitive is NOT guarded, so mixed data-layer files keep
        // calling it structurally for order-key / sibling math.
        { code: `const kids = await tx.childrenOf(id, ws)`, options: [{check: 'query'}] },
        { code: `const kids = await tx.childrenOf(parentId)`, options: [{check: 'query'}] },
      ],
      invalid: [
        {
          code: `const rows = repo.query.subtree({id: block.id})`,
          errors: [{ messageId: 'explicitChildView' }],
        },
        {
          code: `useHandle(repo.query.childIds({id, hydrate: true}))`,
          errors: [{ messageId: 'explicitChildView' }],
        },
        {
          code: `const kids = await tx.childrenOf(id, ws)`,
          errors: [{ messageId: 'explicitChildView' }],
        },
        {
          code: `const kids = await tx.childrenOf(parentId)`,
          errors: [{ messageId: 'explicitChildView' }],
        },
        // …but a query handle IS guarded under `check: 'query'` — that's what
        // makes the rule catch new read-out consumers anywhere in `src/`
        // (the agent bridge's `get-subtree`, an export action) rather than
        // only inside a hand-maintained list of display directories.
        {
          code: `const rows = await repo.query.subtree({id: rootId}).load()`,
          options: [{check: 'query'}],
          errors: [{ messageId: 'explicitChildView' }],
        },
      ],
    },
  )
})
