import { describe, expect, it } from 'vitest'
import { getBreadcrumbContentPreview } from '@/components/renderer/breadcrumbPreview'

describe('getBreadcrumbContentPreview', () => {
  it('uses only the first physical line for multiline content', () => {
    expect(getBreadcrumbContentPreview('first line\nsecond line\nthird line')).toBe('first line')
  })

  it('treats CRLF and CR newlines as line boundaries', () => {
    expect(getBreadcrumbContentPreview('windows line\r\nnext line')).toBe('windows line')
    expect(getBreadcrumbContentPreview('classic mac line\rfollowing line')).toBe('classic mac line')
  })
})
