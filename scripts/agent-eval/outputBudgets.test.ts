import { describe, expect, it } from 'vitest'
import { probeOutput } from './outputBudgets'

describe('probeOutput', () => {
  const a = '11111111-1111-5111-8111-111111111111'
  const b = '22222222-2222-5222-8222-222222222222'
  const c = '33333333-3333-5333-8333-333333333333'

  it('digests one graph alike in two workspaces, whose block ids differ', () => {
    expect(probeOutput(`- [${a}] Kestrel\n  - [${b}] see [${a}]`).digest)
      .toBe(probeOutput(`- [${c}] Kestrel\n  - [${a}] see [${c}]`).digest)
  })

  it('tells apart outputs that differ in content or in which block is which', () => {
    const output = probeOutput(`- [${a}] Kestrel\n  - [${b}] see [${a}]`).digest
    expect(probeOutput(`- [${a}] Kestrel\n  - [${b}] see [${b}]`).digest).not.toBe(output)
    expect(probeOutput(`- [${a}] Kestrel\n  - [${b}] see [${a}].`).digest).not.toBe(output)
  })
})
