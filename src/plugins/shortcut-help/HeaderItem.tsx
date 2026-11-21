import { isMacPlatform } from '@/utils/platform.js'
import { shortcutHelpToggle } from './toggleStore.ts'

const getShortcut = () => (isMacPlatform() ? '⌘/' : 'Ctrl+/')

export function ShortcutHelpHeaderItem() {
  return (
    <button
      type="button"
      className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:px-1.5"
      // Keep editor focus until the overlay acquires its edit-mode keepalive.
      onMouseDown={event => event.preventDefault()}
      onClick={() => shortcutHelpToggle.toggle()}
      title={`Open shortcut help (?) or press ${getShortcut()}`}
      aria-label="Help"
    >
      <span aria-hidden="true" className="font-semibold">?</span>
      <span className="hidden sm:inline">Help</span>
    </button>
  )
}
