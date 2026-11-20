import { handleWriteRequest, type WriteRequest } from './byteStoreWriter.js'

self.onmessage = (event: MessageEvent<WriteRequest>) => {
  void handleWriteRequest(() => navigator.storage.getDirectory(), event.data).then((reply) => self.postMessage(reply))
}
