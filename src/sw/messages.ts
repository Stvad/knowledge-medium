export const RECORD_PREVIEW_DATABASE_MESSAGE = 'KM_RECORD_PREVIEW_DATABASE'

export interface RecordPreviewDatabaseMessage {
  type: typeof RECORD_PREVIEW_DATABASE_MESSAGE
  databaseName: string
}
