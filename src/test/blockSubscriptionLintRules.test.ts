import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import blockSubscriptions from '../../eslint-rules/block-subscriptions.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
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
          code: `
            const query = {types: ['page']}
          `,
        },
        {
          code: `
            const blockMap = new Map()
            blockMap.set('types', ['page'])
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
          filename: '/repo/src/plugins/roam-import/import.ts',
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
        {
          filename: '/repo/src/utils/import.ts',
          code: `
            tx.update(id, {properties: {types: ['page']}})
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/utils/import.ts',
          code: `
            const properties = {'types': ['page']}
            tx.update(id, {properties})
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/utils/import.ts',
          code: `
            const next = {...block.properties, ['types']: ['page']}
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/utils/import.ts',
          code: `
            properties.types = ['page']
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/data/targets.ts',
          code: `
            tx.setProperty(id, 'types' as any, ['page'])
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/components/BlockProperties.tsx',
          code: `
            block.set('types' as any, ['page'])
          `,
          errors: [{messageId: 'directWrite'}],
        },
        {
          filename: '/repo/src/components/BlockProperties.tsx',
          code: `
            repo.mutate.setProperty({id, schema: 'types' as any, value: ['page']})
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

  ruleTester.run(
    'prefer-set-block-focus',
    blockSubscriptions.rules['prefer-set-block-focus'],
    {
      valid: [
        {
          // Lone setFocusedBlockId — fine on its own.
          code: `
            import { setFocusedBlockId } from '@/data/properties'
            function handler({uiStateBlock, block}) {
              setFocusedBlockId(uiStateBlock, block.id)
            }
          `,
        },
        {
          // Lone setIsEditing — fine on its own.
          code: `
            import { setIsEditing } from '@/data/properties'
            function handler({uiStateBlock}) {
              setIsEditing(uiStateBlock, false)
            }
          `,
        },
        {
          // Same scope but only one of the pair — no flag.
          code: `
            import { setFocusedBlockId, requestEditorFocus } from '@/data/properties'
            function handler({uiStateBlock, target}) {
              setFocusedBlockId(uiStateBlock, target.id)
              requestEditorFocus(uiStateBlock)
            }
          `,
        },
        {
          // Pair lives in separate sibling blocks — rule doesn't cross.
          code: `
            import { setFocusedBlockId, setIsEditing } from '@/data/properties'
            function handler({uiStateBlock, block, cond}) {
              if (cond) {
                setFocusedBlockId(uiStateBlock, block.id)
              } else {
                setIsEditing(uiStateBlock, false)
              }
            }
          `,
        },
        {
          // Already migrated.
          code: `
            import { setBlockFocus } from '@/data/properties'
            async function handler({uiStateBlock, block}) {
              await setBlockFocus(uiStateBlock, block.id, {edit: true})
            }
          `,
        },
      ],
      invalid: [
        {
          code: `
            import { setFocusedBlockId, setIsEditing } from '@/data/properties'
            function handler({uiStateBlock, block}) {
              setFocusedBlockId(uiStateBlock, block.id)
              setIsEditing(uiStateBlock, true)
            }
          `,
          errors: [
            {messageId: 'preferSetBlockFocus'},
            {messageId: 'preferSetBlockFocus'},
          ],
        },
        {
          // Non-adjacent but still same scope.
          code: `
            import { setFocusedBlockId, setIsEditing, requestEditorFocus } from '@/data/properties'
            function handler({uiStateBlock, target}) {
              setFocusedBlockId(uiStateBlock, target.id)
              requestEditorFocus(uiStateBlock)
              setIsEditing(uiStateBlock, true)
            }
          `,
          errors: [
            {messageId: 'preferSetBlockFocus'},
            {messageId: 'preferSetBlockFocus'},
          ],
        },
        {
          // Renamed imports still resolve.
          code: `
            import { setFocusedBlockId as setFocus, setIsEditing as setEdit } from '@/data/properties'
            function handler({uiStateBlock, block}) {
              setFocus(uiStateBlock, block.id)
              setEdit(uiStateBlock, true)
            }
          `,
          errors: [
            {messageId: 'preferSetBlockFocus'},
            {messageId: 'preferSetBlockFocus'},
          ],
        },
      ],
    },
  )
})
