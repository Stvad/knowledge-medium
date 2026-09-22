/**
 * The byte store's writer worker (see byteStoreWriter.ts): answers each
 * {@link WriteRequest} with a {@link WriteReply} after writing the bytes through
 * a sync access handle — the only OPFS write primitive WebKit before Safari 26
 * exposes, and only in a worker.
 */

import { handleWriteRequest, type WriteRequest } from './byteStoreWriter.js'

self.onmessage = (event: MessageEvent<WriteRequest>) => {
  void handleWriteRequest(() => navigator.storage.getDirectory(), event.data).then((reply) => self.postMessage(reply))
}
