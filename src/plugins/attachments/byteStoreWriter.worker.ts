/**
 * The byte store's writer worker (see byteStoreWriter.ts): answers each
 * {@link WriteRequest} with a {@link WriteReply} after writing the bytes through
 * a sync access handle — the only OPFS write primitive WebKit before Safari 26
 * exposes, and only in a worker. The root is re-opened per request rather than
 * cached: a request arrives seconds or hours apart, and the handle is cheap.
 */

import { handleWriteRequest, type WriteRequest } from './byteStoreWriter.js'

self.onmessage = (event: MessageEvent<WriteRequest>) => {
  const request = event.data
  navigator.storage
    .getDirectory()
    .then((root) => handleWriteRequest(root, request))
    .then(
      (reply) => self.postMessage(reply),
      (err: unknown) =>
        self.postMessage({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
}
