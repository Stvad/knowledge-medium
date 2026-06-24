import { describe, expect, it } from 'vitest'
import { extractBlockDetails, parseRejectionError, summarizeOp } from '../rejectedHelpers.ts'

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

describe('extractBlockDetails', () => {
  it('surfaces workspace, changed fields, and a content preview from a PATCH', () => {
    const data = JSON.stringify({
      op: 'PATCH',
      type: 'blocks',
      id: 'b1',
      data: {workspace_id: 'ws-1', content: 'new things', updated_at: 1700000000000},
    })
    expect(extractBlockDetails(data)).toEqual({
      workspaceId: 'ws-1',
      // workspace_id is routing metadata, surfaced separately — not a "changed field".
      fields: ['content', 'updated_at'],
      contentPreview: 'new things',
      encrypted: false,
    })
  })

  it('flags encrypted content instead of dumping the ciphertext envelope', () => {
    const data = JSON.stringify({
      op: 'PATCH',
      type: 'blocks',
      id: 'b1',
      data: {workspace_id: 'ws-1', content: 'enc:v1:4A6hEDnol9bZ_ciphertext_bytes'},
    })
    const details = extractBlockDetails(data)
    expect(details.encrypted).toBe(true)
    expect(details.contentPreview).toBeNull()
  })

  it('reports a null workspace when the payload omits workspace_id (the stale-trigger bug shape)', () => {
    // Pre-fix clients stripped workspace_id from content-only PATCHes; the
    // dialog should make that visibly absent rather than guess.
    const data = JSON.stringify({
      op: 'PATCH',
      type: 'blocks',
      id: 'b1',
      data: {content: 'new things'},
    })
    expect(extractBlockDetails(data).workspaceId).toBeNull()
  })

  it('lists payload columns even when there is no previewable content (properties-only edit)', () => {
    const data = JSON.stringify({
      op: 'PATCH',
      type: 'blocks',
      id: 'b1',
      data: {workspace_id: 'ws-1', properties_json: '{"topLevelBlockId":"x"}'},
    })
    const details = extractBlockDetails(data)
    expect(details.fields).toEqual(['properties_json'])
    expect(details.contentPreview).toBeNull()
  })

  it('truncates a long content preview', () => {
    const long = 'x'.repeat(200)
    const data = JSON.stringify({op: 'PUT', type: 'blocks', id: 'b1', data: {content: long}})
    const preview = extractBlockDetails(data).contentPreview
    expect(preview).not.toBeNull()
    expect(preview!.length).toBeLessThan(long.length)
    expect(preview!.endsWith('…')).toBe(true)
  })

  it('returns empty details for a DELETE envelope (no data) and for malformed JSON', () => {
    const del = JSON.stringify({op: 'DELETE', type: 'blocks', id: 'b1'})
    expect(extractBlockDetails(del)).toEqual({
      workspaceId: null, fields: [], contentPreview: null, encrypted: false,
    })
    expect(extractBlockDetails('not json')).toEqual({
      workspaceId: null, fields: [], contentPreview: null, encrypted: false,
    })
  })
})
