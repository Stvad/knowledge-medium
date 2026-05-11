// Minimal progress banner for long-running Roam imports.
//
// The import can take minutes on a 150-MB-class graph; without a
// visible signal the user can't tell whether the tab is hung or
// chugging through chunks. The banner is a single fixed-position
// element appended to <body>, updated in place via textContent, and
// removed when the import settles. No React, no dependencies — keeps
// the helper usable from the command-palette handler that lives
// outside the React tree, and avoids paying for a re-render per chunk
// when an import emits hundreds of progress messages.

interface ProgressBanner {
  update: (message: string) => void
  done: (finalMessage?: string) => void
  fail: (message: string) => void
}

const STYLE = [
  'position: fixed',
  'top: 12px',
  'left: 50%',
  'transform: translateX(-50%)',
  'z-index: 99999',
  'background: rgba(20, 20, 22, 0.92)',
  'color: #f5f5f5',
  'padding: 10px 16px',
  'border-radius: 8px',
  'font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'box-shadow: 0 6px 20px rgba(0,0,0,0.25)',
  'max-width: min(80vw, 720px)',
  'pointer-events: none',
].join(';')

export const showProgressBanner = (initial: string): ProgressBanner => {
  const el = document.createElement('div')
  el.setAttribute('data-roam-import-progress', '')
  el.setAttribute('style', STYLE)
  el.textContent = initial
  document.body.appendChild(el)

  const remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el)
  }

  return {
    update: (message: string) => {
      el.textContent = message
    },
    done: (finalMessage?: string) => {
      if (finalMessage === undefined) {
        remove()
        return
      }
      el.textContent = finalMessage
      // Brief lingering display so a fast import isn't invisible.
      window.setTimeout(remove, 2500)
    },
    fail: (message: string) => {
      el.style.background = 'rgba(140, 30, 30, 0.95)'
      el.textContent = message
      window.setTimeout(remove, 6000)
    },
  }
}
