import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { useActionKeyHints, shortcutTitle } from '@/shortcuts/actionKeyHints.js'
import { FIND_REPLACE_ACTION_ID, findReplaceToggle } from './toggleStore.ts'

export function FindReplaceHeaderItem() {
  const hint = useActionKeyHints(ActionContextTypes.GLOBAL).get(FIND_REPLACE_ACTION_ID)
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5"
      onClick={() => findReplaceToggle.toggle()}
      title={shortcutTitle('Find and replace', hint)}
      aria-label="Find and replace"
    >
      <Search className="h-4 w-4"/>
      {hint && <Kbd className="hidden sm:inline-flex">{hint}</Kbd>}
    </button>
  )
}
