import { Search } from 'lucide-react'
import { ThemeToggle } from './ui/theme-toggle'
import { useSignOut, useUser } from '@/components/Login'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher'
import { PendingInvitations } from '@/components/workspace/PendingInvitations'


export function Header() {
  const user = useUser()
  const signOut = useSignOut()
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const modKey = isMac ? '⌘' : 'Ctrl+'

  return (
    <div className="flex items-center justify-between py-2 gap-4">
      <div className="flex items-center gap-2">
        <WorkspaceSwitcher/>
      </div>
      <div className="flex items-center gap-4">
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('toggle-quick-find'))
          }}
          title="Find or create page or block"
        >
          <Search className="h-4 w-4"/>
          <kbd
            className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {modKey}P
          </kbd>
        </button>
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('toggle-command-palette'))
          }}
        >
          <span>Command</span>
          <kbd
            className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {modKey}K
          </kbd>
        </button>
        <PendingInvitations/>
        <ThemeToggle/>
        {user && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{user.name}</span>
            <button
              className="hover:text-foreground transition-colors underline-offset-2 hover:underline"
              onClick={() => { void signOut() }}
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
