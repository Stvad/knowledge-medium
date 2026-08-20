// Authoring sources for the example extensions seeded into a fresh
// tutorial workspace and inserted on demand by the
// `insert_example_extensions` NORMAL_MODE action.
//
// Each entry is an ESM module text whose `default` export is an
// AppExtension — see dynamicExtensions.ts for the contract. Imports use
// real module paths (e.g. `@/extensions/core.js`, `@/data/api/index.js`),
// which resolve through the page-global importmap to the same module
// instances the running app uses.
//
// Renderer-bearing examples register a renderer via blockRenderersFacet
// and compose with the default block chrome by delegating to
// DefaultBlockRenderer with a custom ContentRenderer prop — same shape
// as plugins/video-player/VideoPlayerRenderer. The block keeps its
// bullet, children, properties, and edit affordances; only the
// content area is customized.
//
// The sources are REAL SOURCE FILES under ./examples, inlined here as
// text at build time (mirrors the authoring catalog's ./examples —
// see authoringCatalog.ts). As files they sit in the app tsconfig and
// the eslint scope, so `pnpm run check` fails on a broken example
// instead of shipping it to a fresh workspace as a broken tutorial.
import helloRendererSource from './examples/helloRenderer.tsx?raw'
import foldAllActionSource from './examples/foldAllAction.ts?raw'
import emojiReactSource from './examples/emojiReact.tsx?raw'
import kudosFacetSource from './examples/kudosFacet.tsx?raw'
import splitLayoutSource from './examples/splitLayout.tsx?raw'
import layoutRendererOverrideSource from './examples/layoutRendererOverride.tsx?raw'
import defaultRendererPlaceholderSource from './examples/defaultRendererPlaceholder.tsx?raw'

import type { Block } from '../data/block'
import { ChangeScope } from '@/data/api'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { createChild } from '@/data/mutators'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties'

export interface ExampleExtensionDefinition {
  /** Stable, kebab-case label used in commit history and source attribution. */
  id: string
  /** Display name stored on the extension block. */
  name: string
  /** Description stored on the extension block. */
  description: string
  /** ESM module text. */
  source: string
}

export const exampleExtensions: readonly ExampleExtensionDefinition[] = [
  {
    id: 'hello-renderer',
    name: 'Hello renderer',
    description: "Content-renderer variant gated by 'user:hello = true'.",
    source: helloRendererSource.trimEnd(),
  },
  {
    id: 'fold-all-action',
    name: 'Fold all',
    description: 'Action that folds/unfolds every block in the current view (Cmd+Shift+F).',
    source: foldAllActionSource.trimEnd(),
  },
  {
    id: 'emoji-react',
    name: 'Emoji reactions',
    description: 'Multi-facet plugin: content decorator + click handler + keyboard action for adding emoji reactions to blocks.',
    source: emojiReactSource.trimEnd(),
  },
  {
    id: 'kudos-facet',
    name: 'Kudos facet',
    description: "Defines a brand-new facet and registers a property-keyed 'kudos-banner' renderer that other extensions can contribute to.",
    source: kudosFacetSource.trimEnd(),
  },
  {
    id: 'split-layout',
    name: 'Split layout',
    description: "Block-layout variant for blocks tagged 'user:layout = split' — places content and children side by side.",
    source: splitLayoutSource.trimEnd(),
  },
  {
    id: 'layout-renderer-override',
    name: 'Layout renderer override',
    description: "Overrides the app-wide 'layout' renderer id and wraps the normal panel layout with a custom frame.",
    source: layoutRendererOverrideSource.trimEnd(),
  },
  {
    id: 'default-renderer-placeholder',
    name: 'Default renderer placeholder',
    description: "Overrides the fallback 'default' renderer id so ordinary empty blocks show a muted read-mode placeholder.",
    source: defaultRendererPlaceholderSource.trimEnd(),
  },
]

/**
 * Append the example-extension blocks under `parentBlock`. Used by the
 * `insert_example_extensions` command to re-seed examples in any
 * workspace without rebuilding the user.
 */
export const insertExampleExtensionsUnder = async (
  parentBlock: Block,
): Promise<Block[]> => {
  const repo = parentBlock.repo
  const created: Block[] = []
  const typeSnapshot = repo.snapshotTypeRegistries()
  for (const example of exampleExtensions) {
    const id = await repo.tx(async tx => {
      const childId = await tx.run(createChild, {
        parentId: parentBlock.id,
        content: example.source,
      })
      await repo.addTypeInTx(tx, childId, EXTENSION_TYPE, {
        [extensionNameProp.name]: example.name,
        [extensionDescriptionProp.name]: example.description,
      }, typeSnapshot)
      return childId
    }, {scope: ChangeScope.BlockDefault, description: 'insert example extension'})
    created.push(repo.block(id))
  }
  return created
}
