import { base64 } from '@scure/base'
import type { AddMediaResult } from '@knowledge-medium/agent-cli/protocol'
import { CAPTURE_FAILURE_MESSAGE } from '@/plugins/attachments/assetUpload.js'
import type { MediaCaptureResult } from '@/plugins/attachments/mediaCapture.js'

export type MediaCapture = (file: File) => Promise<MediaCaptureResult>

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
  workspaceId: string,
  input: AddMediaInput,
  capture: MediaCapture,
): Promise<AddMediaResult> => {
  const bytes = decode(input.base64)
  const captured = await capture(new File([bytes], input.filename ?? '', {type: input.mime ?? ''}))
  if (!captured.ok) throw new Error(`add-media (workspace ${workspaceId}): ${CAPTURE_FAILURE_MESSAGE[captured.reason]}`)
  return {id: captured.assetBlockId, deduped: captured.deduped, reference: `((${captured.assetBlockId}))`}
}
