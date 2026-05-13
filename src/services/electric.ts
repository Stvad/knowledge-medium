import { hasSupabaseAuthConfig, supabase } from '@/services/supabase.ts'

const electricShapeProxyUrl = import.meta.env.VITE_ELECTRIC_SHAPE_PROXY_URL?.trim()

export const hasElectricSyncConfig = Boolean(electricShapeProxyUrl)
export const hasRemoteSyncConfig = hasSupabaseAuthConfig && hasElectricSyncConfig

export type ElectricShapeName = 'blocks' | 'workspaces' | 'workspace_members'

export const electricShapeUrl = (shapeName: ElectricShapeName): string => {
  if (!electricShapeProxyUrl) {
    throw new Error('Electric shape proxy URL is not configured')
  }

  return `${electricShapeProxyUrl.replace(/\/+$/, '')}/${shapeName}`
}

export const getElectricAuthHeader = async (): Promise<string | null> => {
  if (!supabase) return null

  const {data, error} = await supabase.auth.getSession()
  if (error) throw error

  const token = data.session?.access_token
  return token ? `Bearer ${token}` : null
}
