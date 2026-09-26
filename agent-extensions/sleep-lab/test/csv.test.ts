import {describe, expect, it} from 'vitest'

import {parseCsv, rowsWithHeader} from '../src/import/csv'

describe('parseCsv', () => {
  it('splits plain comma-separated lines', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('"a,b",c\n1,2')).toEqual([['a,b', 'c'], ['1', '2']])
  })

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('"a""b",c')).toEqual([['a"b', 'c']])
  })

  it('keeps a newline inside a quoted field as part of the field', () => {
    expect(parseCsv('"line one\nline two",c')).toEqual([['line one\nline two', 'c']])
  })

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('flushes the last row when the file has no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('reads an empty field as an empty string', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
  })
})

describe('rowsWithHeader', () => {
  it('maps rows by header name', () => {
    const {header, rows} = rowsWithHeader('name,age\nAlice,30\nBob,40')
    expect(header).toEqual(['name', 'age'])
    expect(rows).toEqual([{name: 'Alice', age: '30'}, {name: 'Bob', age: '40'}])
  })

  it('skips a metadata first line when asked', () => {
    const text = 'junk,metadata,line\nname,age\nAlice,30'
    expect(rowsWithHeader(text, {skipFirstLine: true})).toEqual({
      header: ['name', 'age'],
      rows: [{name: 'Alice', age: '30'}],
    })
  })

  it('keeps only the header columns when a row has an extra trailing field', () => {
    const {rows} = rowsWithHeader('name,age\nAlice,30,')
    expect(rows).toEqual([{name: 'Alice', age: '30'}])
  })

  it('fills a short row\'s missing columns with an empty string', () => {
    const {rows} = rowsWithHeader('name,age,city\nAlice,30')
    expect(rows).toEqual([{name: 'Alice', age: '30', city: ''}])
  })

  it('drops a blank line rather than emitting an all-empty row', () => {
    const {rows} = rowsWithHeader('name,age\nAlice,30\n\nBob,40')
    expect(rows).toEqual([{name: 'Alice', age: '30'}, {name: 'Bob', age: '40'}])
  })
})
