import type { AttachmentCleanerIO } from './attachmentCleaner.js'

/** What the conversion needs of the attachments plugin, on top of the
 *  cleaner's view of the workspace's Storage folder. */
export interface ConversionAttachmentsIO extends AttachmentCleanerIO {
  /** Keep bytes, already verified, in this device's byte store under `name`. */
  writeLocal(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** The content hash a stored block row carries if it is a media block, by
   *  its `properties_json`; null for any other row. The bundle reads the
   *  server's rows, not this device's. */
  mediaHashOf(propertiesJson: string): string | null
  /** This device's attachment uploads for the workspace that haven't been
   *  confirmed: staged, pending or failed. */
  pendingUploads(): Promise<number>
}
