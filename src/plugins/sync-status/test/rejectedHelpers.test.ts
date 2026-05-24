import { describe, expect, it } from 'vitest'
import { parseRejectionError, summarizeOp } from '../rejectedHelpers.ts'

describe('parseRejectionError', () => {
  it('unwraps the PostgrestError JSON envelope Supabase stores in error_message', () => {
    // The upload handler stores `err.message` verbatim, and Supabase's
    // PostgrestError serialises its full body into .message. The dialog
    // needs the human sentence on its own line, with code/details
    // available for an expanded view.
    const raw = JSON.stringify({
      code: '23503',
      details: 'Key is not present in table "blocks".',
      hint: null,
      message: 'insert or update on table "blocks" violates foreign key constraint "blocks_workspace_id_parent_id_fkey"',
    })
    expect(parseRejectionError(raw)).toEqual({
      message: 'insert or update on table "blocks" violates foreign key constraint "blocks_workspace_id_parent_id_fkey"',
      code: '23503',
      details: 'Key is not present in table "blocks".',
      hint: null,
    })
  })

  it('falls back to the raw string when the message is not JSON', () => {
    // Plain Error throws (or non-Error throws) land as a flat string in
    // error_message. Show it as-is rather than a misleading parse error.
    expect(parseRejectionError('fetch failed')).toEqual({
      message: 'fetch failed',
      code: null,
      details: null,
      hint: null,
    })
  })

  it('handles missing / empty input with a placeholder', () => {
    expect(parseRejectionError(null).message).toBe('(no error message)')
    expect(parseRejectionError('').message).toBe('(no error message)')
  })
})

describe('summarizeOp', () => {
  it('extracts op, table, and a short id from the upload envelope', () => {
    // The envelope shape mirrors what the upload-routing triggers write
    // into ps_crud.data. The dialog renders this as a one-line summary
    // so a list of rejections is scannable without expanding payloads.
    const data = JSON.stringify({
      op: 'PUT',
      type: 'blocks',
      id: '13087947-c577-5422-b43f-c169e0358c3d',
      data: {/* full row state */},
    })
    expect(summarizeOp(data)).toEqual({
      op: 'PUT',
      table: 'blocks',
      id: '13087947-c577-5422-b43f-c169e0358c3d',
      idShort: '13087947…8c3d',
    })
  })

  it('handles malformed JSON without throwing', () => {
    const result = summarizeOp('not json at all')
    expect(result.op).toBe('OP')
    expect(result.table).toBe('unknown')
  })

  it('passes short ids through without truncation', () => {
    const data = JSON.stringify({op: 'PATCH', type: 'blocks', id: 'short'})
    expect(summarizeOp(data).idShort).toBe('short')
  })
})
