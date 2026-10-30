// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {marginHosts} from './margin'
import type {ScopeThread} from './scopeThreads'

const thread = (threadId: string, path: string[], open = true): ScopeThread => ({threadId, open, path})

describe('marginHosts', () => {
  // P ─ A (collapsed) ─ A1;  P ─ B
  const rows = ['P', 'A', 'B']

  it('gives a rendered target its own cards, in outline order, the scope root included', () => {
    const hosts = marginHosts([thread('t1', ['B']), thread('t2', []), thread('t3', ['A'])], rows, 'P', false)
    expect(hosts.cardRows).toEqual(['P', 'A', 'B'])
    expect([...hosts.stubs]).toEqual([])
  })

  it('counts open threads whose row is not rendered on the nearest row that is', () => {
    const hosts = marginHosts([thread('t1', ['A1', 'A']), thread('t2', ['A2', 'A1', 'A']), thread('t3', ['A1', 'A'], false)], rows, 'P', true)
    expect(hosts.cardRows).toEqual([])
    expect([...hosts.stubs]).toEqual([['A', 2]])
  })

  it('shows closed threads only when asked for', () => {
    expect(marginHosts([thread('t1', ['B'], false)], rows, 'P', false).cardRows).toEqual([])
    expect(marginHosts([thread('t1', ['B'], false)], rows, 'P', true).cardRows).toEqual(['B'])
  })
})
