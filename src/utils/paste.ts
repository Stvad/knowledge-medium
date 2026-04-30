import { Block } from '@/data/internals/block'
import { Repo } from '@/data/internals/repo'
import { importState } from '@/utils/state.ts'
import { parseMarkdownToBlocks } from '@/utils/markdownParser.ts'

export async function pasteMultilineText(
  pastedText: string,
  pasteTarget: Block,
  repo: Repo,
  {position = 'after'}: {position?: 'before' | 'after'} = {},
) {
  const parent = await pasteTarget.parent()
  if (!parent) return []

  const blocks = parseMarkdownToBlocks(pastedText)
    .map(block => ({parentId: parent.id, ...block}))
  const blockMap = await importState({blocks}, repo)

  const rootBlocks = Array.from(blockMap.values())
    .filter(block => block.dataSync()?.parentId === parent.id)

  const targetIndex = await pasteTarget.index()
  await parent.insertChildren({
    blocks: rootBlocks,
    position: position === 'before' ? targetIndex : targetIndex + 1,
  })

  return rootBlocks
}

export async function pasteFromClipboard(
  pasteTarget: Block,
  repo: Repo,
  options: {position?: 'before' | 'after'} = {},
) {
  const text = await navigator.clipboard.readText()
  if (!text) return []
  return pasteMultilineText(text, pasteTarget, repo, options)
}
