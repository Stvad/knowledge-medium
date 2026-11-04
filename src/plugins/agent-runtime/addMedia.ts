import { base64 } from '@scure/base'
import type { AddMediaResult } from '@knowledge-medium/agent-cli/protocol'
import type { Repo } from '@/data/repo'
import { CAPTURE_FAILURE_MESSAGE, captureMediaFromFiles } from '@/plugins/attachments/assetUpload.js'
import { agentTxOptions } from './agentWrites.ts'
import { refuseDanglingBlockRefs } from './blockRefTargets.ts'

export interface AddMediaInput {
  base64: string
  filename?: string
  mime?: string
}

const decode = (encoded: string): Uint8Array<ArrayBuffer> => {
  try {
    return Uint8Array.from(base64.decode(encoded))
  } catch (cause) {
    throw new Error('add-media: base64 is not valid base64.', {cause})
  }
}

/** A file's bytes as a media block under the workspace's Assets page, deduplicated
 *  by content. Placing it in a note is the caller's next write, of `reference`. */
export const addMedia = async (
  repo: Repo,
  workspaceId: string,
  input: AddMediaInput,
): Promise<AddMediaResult> => {
  const bytes = decode(input.base64)
  // The filename becomes the block's content.
  await refuseDanglingBlockRefs(repo, 'add-media', [input.filename], async () => '')
  const [captured] = await captureMediaFromFiles(
    repo,
    workspaceId,
    [new File([bytes], input.filename ?? '', {type: input.mime ?? ''})],
    {txDescription: agentTxOptions('add-media').description},
  )
  if (!captured.ok) throw new Error(`add-media (workspace ${workspaceId}): ${CAPTURE_FAILURE_MESSAGE[captured.reason]}`)
  return {id: captured.assetBlockId, workspaceId, deduped: captured.deduped, reference: `((${captured.assetBlockId}))`}
}
