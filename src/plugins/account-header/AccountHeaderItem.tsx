import { useSignOut, useUser } from '@/components/Login.tsx'

export function AccountHeaderItem() {
  const user = useUser()
  const signOut = useSignOut()

  if (!user) return null

  return (
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
  )
}
