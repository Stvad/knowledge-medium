import type {PostResult} from './types'
import {PLATFORM_LABELS} from './types'

export const annotateParent = async (
  repo: any,
  blockId: string,
  results: PostResult[],
): Promise<void> => {
  const successResults = results.filter(result => result.success && result.url)
  if (successResults.length === 0) return
  const block = repo.block(blockId)
  const data = await block.load()
  const current = data?.content ?? ''
  const links = successResults
    .map(result => `[${PLATFORM_LABELS[result.platform]}](${result.url})`)
    .join(' ')
  const timestamp = new Date().toLocaleString()
  await block.setContent(`${current} (Posted ${timestamp}: ${links})`)
}
