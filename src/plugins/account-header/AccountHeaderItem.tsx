import { LogOut } from 'lucide-react'
import { useSignOut, useUser } from '@/components/Login.tsx'

export function AccountHeaderItem() {
  const user = useUser()
  const signOut = useSignOut()

  if (!user) return null

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{user.name}</span>
      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => { void signOut() }}
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4"/>
      </button>
    </div>
  )
}
