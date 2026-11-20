import {expect, vi} from 'vitest'

/** Waits for `earlier` to render ahead of `later`. Takes queries rather than
 *  nodes, and compares exactly: a row can be replaced just after it mounts, and
 *  comparing a detached node reports FOLLOWING (with DISCONNECTED) whatever the
 *  order is. */
export const waitForRenderOrder = (earlier: () => Node, later: () => Node) =>
  vi.waitFor(
    () => expect(earlier().compareDocumentPosition(later())).toBe(Node.DOCUMENT_POSITION_FOLLOWING),
    {timeout: 2_000},
  )
