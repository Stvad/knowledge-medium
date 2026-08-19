import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { isMacPlatform } from '@/utils/platform.js'
import { findReplaceToggle } from './toggleStore.ts'

const getModKey = () => (isMacPlatform() ? '⌘' : 'Ctrl+')

export function FindReplaceHeaderItem() {
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5"
      onClick={() => findReplaceToggle.toggle()}
      title="Find and replace"
      aria-label="Find and replace"
    >
      <Search className="h-4 w-4"/>
      <Kbd className="hidden sm:inline-flex">{getModKey()}⇧F</Kbd>
    </button>
  )
}
