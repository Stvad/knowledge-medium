import { describe, expect, it } from 'vitest'
import { readClipboardContent } from '../clipboard'

const payload = (types: Record<string, string>, files: File[] = []) => ({
  getData: (type: string) => types[type] ?? '',
  files: Object.assign(files, {item: (i: number) => files[i]}) as unknown as FileList,
})

describe('readClipboardContent', () => {
  it('reads text, html and files', () => {
    const file = new File(['x'], 'x.png')
    expect(readClipboardContent(payload({'text/plain': 'a', 'text/html': '<b>a</b>'}, [file])))
      .toEqual({text: 'a', html: '<b>a</b>', files: [file]})
  })

  it('counts html alone as something to paste (a copied <img>)', () => {
    expect(readClipboardContent(payload({'text/html': '<img src="https://e.com/a.png">'})))
      .toEqual({text: '', html: '<img src="https://e.com/a.png">', files: []})
  })

  it('counts files alone as something to paste', () => {
    expect(readClipboardContent(payload({}, [new File(['x'], 'x.png')]))?.files).toHaveLength(1)
  })

  it('is null when there is nothing to paste', () => {
    expect(readClipboardContent(payload({}))).toBeNull()
    expect(readClipboardContent(null)).toBeNull()
  })
})
