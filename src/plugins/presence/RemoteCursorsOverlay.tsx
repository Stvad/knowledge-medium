/**
 * Fixed, click-through layer that paints remote peers' mouse cursors.
 * Mounted once at app root via `appMountsFacet`.
 *
 * Each cursor is anchored to a block id + fractional offset (see
 * `presenceClient.handlePointerMove`), so we resolve it against the live DOM
 * every paint: this makes the cursor land in the same logical spot across
 * different scroll positions / window widths, and naturally hides cursors
 * whose block is scrolled out of view. We re-paint on the cursor stream and
 * on scroll/resize (rAF-coalesced).
 */
import { useEffect, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { useRemoteCursors } from './hooks.js'
import type { RemoteCursor } from './types.js'

const resolveAnchor = (cursor: RemoteCursor): HTMLElement | null => {
  if (!cursor.blockId) return null
  // Match the publish side: only block shells (`.tm-block`), not the
  // block-refs / property rows that also carry `data-block-id`.
  const matches = document.querySelectorAll<HTMLElement>(
    `.tm-block[data-block-id="${CSS.escape(cursor.blockId)}"]`,
  )
  if (matches.length === 0) return null
  if (cursor.renderScopeId) {
    for (const el of matches) {
      if (el.dataset.renderScopeId === cursor.renderScopeId) return el
    }
  }
  return matches[0]
}

function RemoteCursorView({ cursor }: { cursor: RemoteCursor }) {
  const anchor = resolveAnchor(cursor)
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  const x = rect.left + cursor.nx * rect.width
  const y = rect.top + cursor.ny * rect.height
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${x}px, ${y}px)`,
        willChange: 'transform',
      }}
    >
      <svg width="16" height="22" viewBox="0 0 16 22" fill="none" style={{ display: 'block' }}>
        <path
          d="M1 1L1 16.5L5 12.5L7.5 18.5L10 17.5L7.5 11.5L13 11.5L1 1Z"
          fill={cursor.color}
          stroke="white"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          left: 12,
          top: 12,
          padding: '1px 6px',
          borderRadius: 6,
          background: cursor.color,
          color: 'white',
          fontSize: 11,
          lineHeight: '16px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
        }}
      >
        {cursor.name}
      </span>
    </div>
  )
}

export function RemoteCursorsOverlay() {
  const cursors = useRemoteCursors()
  const [, repaint] = useReducer((n: number) => n + 1, 0)

  // Cursor coordinates are derived from live DOM rects, so they drift on any
  // scroll/resize even when no new cursor packet arrives — repaint then too.
  useEffect(() => {
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(repaint)
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  if (typeof document === 'undefined' || cursors.length === 0) return null

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
      {cursors.map(cursor => (
        <RemoteCursorView key={cursor.clientId} cursor={cursor} />
      ))}
    </div>,
    document.body,
  )
}
