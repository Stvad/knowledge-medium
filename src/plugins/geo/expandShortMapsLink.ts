/** Short Google Maps link → the full URL it redirects to, via the
 *  `resolve-maps-link` edge function. A browser can't follow the redirect
 *  itself: the response carries no CORS headers, so the target is unreadable. */

import { isRemoteSyncActive } from '@/data/repoProvider'
import { supabase } from '@/services/supabase'
import { MapsLinkError } from './resolveMapsLink'

const RESOLVE_MAPS_LINK_FUNCTION = 'resolve-maps-link'

const COPY_FULL_URL = 'open it and copy the full google.com/maps URL instead.'

export const expandShortMapsLink = async (
  url: string,
  {client = supabase, remoteSync = isRemoteSyncActive()}: {
    client?: typeof supabase
    /** A configured client only means auth is SET UP; a local-only session
     *  sends nothing to the server. */
    remoteSync?: boolean
  } = {},
): Promise<string> => {
  if (!client || !remoteSync) {
    throw new MapsLinkError(`Short links need sync to expand — ${COPY_FULL_URL}`)
  }
  const {data, error} = await client.functions.invoke<{url?: unknown}>(
    RESOLVE_MAPS_LINK_FUNCTION,
    {body: {url}},
  )
  if (error || typeof data?.url !== 'string') {
    console.warn('[geo] short link expansion failed', url, error)
    throw new MapsLinkError(`Couldn't expand ${url} — ${COPY_FULL_URL}`)
  }
  return data.url
}
