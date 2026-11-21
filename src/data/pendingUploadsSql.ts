/** Block ids with unsent local edits in PowerSync's `{op, type, id, data}`
 *  upload envelopes. DISTINCT collapses editing bursts for the same block.
 *  Keep this uncorrelated so membership queries scan the queue once.
 *  Exclude NULL ids so `NOT IN` consumers cannot lose every candidate row. */
export const PENDING_UPLOAD_IDS_SQL = `
  SELECT DISTINCT json_extract(data, '$.id') AS id FROM ps_crud
   WHERE json_extract(data, '$.type') = 'blocks'
     AND json_extract(data, '$.id') IS NOT NULL
`
