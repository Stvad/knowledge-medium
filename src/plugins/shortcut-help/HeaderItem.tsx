import { ActionContextTypes } from '@/shortcuts/types.js'
import { useActionKeyHint, shortcutTitle } from '@/shortcuts/actionKeyHints.js'
import { SHORTCUT_HELP_ACTION_ID, shortcutHelpToggle } from './toggleStore.ts'

export function ShortcutHelpHeaderItem() {
  const hint = useActionKeyHint(ActionContextTypes.GLOBAL, SHORTCUT_HELP_ACTION_ID)
  return (
    <button
      type="button"
      className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:px-1.5"
      // Keep editor focus until the overlay acquires its edit-mode keepalive.
      onMouseDown={event => event.preventDefault()}
      onClick={() => shortcutHelpToggle.toggle()}
      title={shortcutTitle('Open shortcut help', hint)}
      aria-label="Help"
    >
      <span aria-hidden="true" className="font-semibold">?</span>
      <span className="hidden sm:inline">Help</span>
    </button>
  )
}
