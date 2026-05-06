import { RuleTester } from 'eslint'
import { describe } from 'vitest'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import blockSubscriptions from '../../eslint-rules/block-subscriptions.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

describe('block subscription ESLint rules', () => {
  ruleTester.run(
    'no-direct-types-prop-writes',
    blockSubscriptions.rules['no-direct-types-prop-writes'],
    {
      valid: [
        {
          code: `
            import { typesProp } from '@/data/properties'
            const [types] = usePropertyValue(block, typesProp)
          `,
        },
        {
          filename: '/repo/src/data/repo.ts',
          options: [{allowIn: ['src/data/repo.ts']}],
          code: `
            import { typesProp } from './properties'
            next[typesProp.name] = typesProp.codec.encode(['page'])
          `,
        },
        {
          filename: '/repo/src/data/targets.test.ts',
          code: `
            import { typesProp } from '@/data/properties'
            const properties = {[typesProp.name]: typesProp.codec.encode(['page'])}
          `,
        },
      ],
      invalid: [
        {
          filename: '/repo/src/data/targets.ts',
          code: `
            import { typesProp } from '@/data/properties'
            tx.setProperty(id, typesProp, ['page'])
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/components/BlockProperties.tsx',
          code: `
            import { typesProp as rawTypesProp } from '@/data/properties.ts'
            next[rawTypesProp.name] = rawTypesProp.codec.encode(['page'])
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/utils/roamImport/import.ts',
          code: `
            import { typesProp } from '@/data/properties'
            const properties = {[typesProp.name]: typesProp.codec.encode(['page'])}
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/components/BlockProperties.tsx',
          code: `
            import { typesProp } from '@/data/properties'
            block.set(typesProp, ['page'])
          `,
          errors: [{messageId: 'directWrite'}],
        },
      ],
    },
  )

  ruleTester.run(
    'no-broad-block-subscriptions',
    blockSubscriptions.rules['no-broad-block-subscriptions'],
    {
      valid: [
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const workspaceId = useHandle(block, { selector: doc => doc?.workspaceId ?? '' })
          `,
        },
        {
          filename: '/repo/src/hooks/useRendererRegistry.tsx',
          options: [{allowUseDataIn: ['src/hooks/useRendererRegistry.tsx']}],
          code: `
            import { useData } from '@/hooks/block.ts'
            useData(block)
          `,
        },
      ],
      invalid: [
        {
          code: `
            import { useData } from '@/hooks/block'
            const data = useData(block)
          `,
          errors: [{messageId: 'noUseData'}],
        },
        {
          code: `
            import { useData as useBlockData } from '@/hooks/block'
            const data = useBlockData(block)
          `,
          errors: [{messageId: 'noUseData'}],
        },
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const data = useHandle(block)
          `,
          errors: [{messageId: 'missingSelector'}],
        },
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const data = useHandle(block, {})
          `,
          errors: [{messageId: 'missingSelector'}],
        },
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const data = useHandle(block, options)
          `,
          errors: [{messageId: 'missingSelector'}],
        },
      ],
    },
  )

  ruleTester.run(
    'prefer-semantic-block-hooks',
    blockSubscriptions.rules['prefer-semantic-block-hooks'],
    {
      valid: [
        {
          code: `
            import { useContent } from '@/hooks/block'
            const content = useContent(block)
          `,
        },
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const workspaceId = useHandle(block, { selector: doc => doc?.workspaceId ?? '' })
          `,
        },
        {
          filename: '/repo/src/hooks/block.ts',
          options: [{allowIn: ['src/hooks/block.ts']}],
          code: `
            import { useHandle } from '@/hooks/block'
            const content = useHandle(block, { selector: doc => doc?.content ?? '' })
          `,
        },
      ],
      invalid: [
        {
          code: `
            import { useHandle } from '@/hooks/block'
            const content = useHandle(block, { selector: doc => doc?.content })
          `,
          errors: [{messageId: 'useContent'}],
        },
        {
          code: `
            import { useHandle as useBlockHandle } from '@/hooks/block'
            const content = useBlockHandle(block, { selector: doc => doc?.content ?? '' })
          `,
          errors: [{messageId: 'useContent'}],
        },
      ],
    },
  )
})
