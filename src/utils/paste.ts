import { Block } from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import { importState } from '@/utils/state.ts'
import { parseMarkdownToBlocks } from '@/utils/markdownParser.ts'

export async function pasteMultilineText(
  pastedText: string,
  pasteTarget: Block,
  repo: Repo,
) {
  const parent = await pasteTarget.parent()
  if (!parent) return []

  const blocks = parseMarkdownToBlocks(pastedText)
    .map(block => ({parentId: parent.id, ...block}))
  const blockMap = await importState({blocks}, repo)

  const rootBlocks = Array.from(blockMap.values())
    .filter(block => block.dataSync()?.parentId === parent.id)

  await parent.insertChildren({
    blocks: rootBlocks,
    position: await pasteTarget.index() + 1,
  })

  return rootBlocks
}
