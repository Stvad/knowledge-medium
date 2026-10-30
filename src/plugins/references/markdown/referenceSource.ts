import type { Plugin } from 'unified'
import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'

/** The block whose content a reference node was rendered from, carried on the
 *  node so the reference components can be module-level
 *  (`MarkdownRenderConfig.components` says why). */
export interface ReferenceSource {
  sourceBlockId: string
  workspaceId: string
}

/** Stamps the source on every node of `types`; list it after the plugin that
 *  creates them. A factory, one plugin per node set, because unified runs a
 *  plugin that is used twice once, at its first position, with the options
 *  merged. */
export const remarkReferenceSource = (
  types: readonly string[],
): Plugin<[ReferenceSource], Root> => ({sourceBlockId, workspaceId}) => tree => {
  visit(tree, node => types.includes(node.type), node => {
    const data = (node.data ??= {}) as {hProperties?: Record<string, unknown>}
    data.hProperties = {...data.hProperties, sourceBlockId, workspaceId}
  })
}

export const referenceSourceOf = (
  node: {properties?: Record<string, unknown>} | undefined,
): ReferenceSource => {
  const sourceBlockId = node?.properties?.sourceBlockId
  const workspaceId = node?.properties?.workspaceId
  if (typeof sourceBlockId !== 'string' || typeof workspaceId !== 'string') {
    throw new Error('reference node rendered without remarkReferenceSource')
  }
  return {sourceBlockId, workspaceId}
}
