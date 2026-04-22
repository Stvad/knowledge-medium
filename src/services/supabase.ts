import { createClient, Session, User as SupabaseAuthUser } from '@supabase/supabase-js'
import { User } from '@/types.ts'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const hasSupabaseAuthConfig = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = hasSupabaseAuthConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null

const getUserName = (user: SupabaseAuthUser) => {
  const metadataName = typeof user.user_metadata?.name === 'string'
    ? user.user_metadata.name.trim()
    : ''

  if (metadataName) return metadataName
  if (user.email) return user.email
  if ('is_anonymous' in user && user.is_anonymous === true) return 'Anonymous'
  return `User ${user.id.slice(0, 8)}`
}

export const sessionUserToAppUser = (session: Session): User => ({
  id: session.user.id,
  name: getUserName(session.user),
})
